import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadTopology } from '../cli/load.ts'
import type { Resolved } from './project.ts'
import { shortHash } from './manifest.ts'
import { findRule, matchEnv, matchExec, matchFetch, matchFile, resolveFile, ruleKey, type Kind, type Rule } from './rules.ts'
import { requireIsolation, sandboxArgv, type Isolation } from './sandbox.ts'
import { allowAlways, allowedRules, audit } from './state.ts'
import type { Answer, Question } from '../core/live.ts'

export type { Answer, Question }

// Runs one plugin process and answers its requests. The process is untrusted: every request is
// checked here against malha-plugin.json, then against this person's earlier answers, and if
// neither settles it, the person is asked.

export interface Asker {
  ask(q: Question): Promise<Answer>
}

/** Answers that last for one CLI run, or for one `malha dev`. */
export class Session {
  readonly approved = new Set<string>()
  readonly denied = new Set<string>()
  /** Allowed calls already in the log, so a live plugin's repeats are logged once. */
  readonly logged = new Set<string>()
}

export interface RunOptions {
  file: string
  plugin: Resolved
  run: { kind: 'command'; name: string } | { kind: 'live' } | { kind: 'notify' } | { kind: 'analytics' } | { kind: 'link' }
  /** Data for the plugin's entry point: the report for notify, the request for analytics and link. */
  input?: unknown
  args?: string[]
  asker: Asker
  session?: Session
  /** The plugin's own console output, one sanitized line at a time. */
  output?: (line: string) => void
  timeoutMs?: number
}

export class PluginError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
  }
}

const LIMITS = { output: 1024 * 1024, execOutput: 64 * 1024 * 1024, fetchBody: 32 * 1024 * 1024, file: 10 * 1024 * 1024, args: 200, arg: 8192, requestBody: 10 * 1024 * 1024 }

/** Drop escape sequences and control characters, so plugin text cannot redraw the terminal. */
export const sanitize = (s: string) =>
  s
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-_]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')

export const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const quote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)

/** A timeout that stops counting while the person is answering a question. */
function deadline(ms: number, onExpire: () => void) {
  let left = ms
  let started = Date.now()
  let timer: NodeJS.Timeout | undefined = setTimeout(onExpire, left)
  return {
    pause() {
      if (!timer) return
      clearTimeout(timer)
      timer = undefined
      left -= Date.now() - started
    },
    resume() {
      if (timer) return
      started = Date.now()
      timer = setTimeout(onExpire, Math.max(left, 1000))
    },
    clear: () => clearTimeout(timer),
  }
}

async function readCapped(res: Response, cap: number) {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > cap) {
      await reader.cancel()
      throw new PluginError(`response is larger than ${cap / 1024 / 1024} MB`, 'MALHA_TOO_LARGE')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function runPlugin(opts: RunOptions): Promise<unknown> {
  const { file, plugin } = opts
  const iso: Isolation = await requireIsolation()
  const session = opts.session ?? new Session()
  const perms = plugin.manifest.permissions
  const scope = `${plugin.name}@${plugin.integrity}`
  const base = { plugin: plugin.name, version: plugin.manifest.version, hash: shortHash(plugin.integrity), network: iso.network }

  // One question at a time, and a second request for the same pattern waits for the first answer.
  let asking: Promise<unknown> = Promise.resolve()
  let clock: ReturnType<typeof deadline> | undefined

  async function permit(kind: Kind, detail: string, test: (pattern: string) => boolean): Promise<Rule> {
    const rule = findRule(perms, kind, test)
    if (!rule) {
      audit(file, { plugin: plugin.name, kind, detail, decision: 'undeclared' })
      throw new PluginError(`not declared in malha-plugin.json: ${kind} ${detail}`, 'MALHA_DENIED')
    }
    const key = `${scope}:${ruleKey(rule)}`
    const settle = async (): Promise<Rule> => {
      if (session.denied.has(key)) throw new PluginError(`you declined: ${detail}`, 'MALHA_DENIED')
      if (session.approved.has(key) || allowedRules(file, plugin.name, plugin.integrity)[ruleKey(rule)]) {
        const entry = `${plugin.name}\0${kind}\0${detail}`
        if (!session.logged.has(entry)) {
          session.logged.add(entry)
          audit(file, { plugin: plugin.name, kind, detail, decision: 'allowed' })
        }
        return rule
      }
      clock?.pause()
      let answer: Answer
      try {
        answer = await opts.asker.ask({ ...base, kind, detail: sanitize(detail), rule: rule.pattern })
      } finally {
        clock?.resume()
      }
      if (answer === 'deny') {
        session.denied.add(key)
        audit(file, { plugin: plugin.name, kind, detail, decision: 'denied' })
        throw new PluginError(`you declined: ${detail}`, 'MALHA_DENIED')
      }
      if (answer === 'always') allowAlways(file, plugin.name, plugin.integrity, [ruleKey(rule)])
      session.approved.add(key)
      audit(file, { plugin: plugin.name, kind, detail, decision: `asked:${answer}` })
      return rule
    }
    const turn = asking.then(settle, settle)
    asking = turn.catch(() => undefined)
    return turn
  }

  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((a) => typeof a === 'string')

  async function handle(op: string, msg: Record<string, unknown>): Promise<unknown> {
    switch (op) {
      case 'topology': {
        if (perms.topology !== 'read' && perms.topology !== 'propose') throw new PluginError('not declared in malha-plugin.json: topology access', 'MALHA_DENIED')
        const { data, errors } = loadTopology(file)
        if (!data) throw new PluginError(`the topology file is invalid: ${errors[0]}`, 'MALHA_INVALID')
        return data
      }
      case 'exec': {
        const { command, args } = msg
        if (typeof command !== 'string' || !strings(args) || args.length > LIMITS.args || args.some((a) => a.length > LIMITS.arg))
          throw new PluginError('exec wants a program name and a list of string arguments', 'MALHA_BAD_REQUEST')
        await permit('exec', [command, ...args].map(quote).join(' '), (p) => matchExec(p, command, args))
        return new Promise((resolve, reject) => {
          execFile(command, args, { cwd: dirname(file), timeout: 120_000, maxBuffer: LIMITS.execOutput, windowsHide: true }, (err, stdout, stderr) => {
            const e = err as (NodeJS.ErrnoException & { code?: string | number; killed?: boolean }) | null
            if (e?.code === 'ENOENT') return reject(new PluginError(`${command} is not installed, or not on PATH`, 'MALHA_NOT_FOUND'))
            if (e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return reject(new PluginError(`${command} printed more than 64 MB`, 'MALHA_TOO_LARGE'))
            if (e?.killed) return reject(new PluginError(`${command} took longer than 2 minutes`, 'MALHA_TIMEOUT'))
            resolve({ stdout, stderr, code: typeof e?.code === 'number' ? e.code : e ? 1 : 0 })
          })
        })
      }
      case 'fetch': {
        const { url, method, headers, body } = msg
        const verb = typeof method === 'string' ? method.toUpperCase() : 'GET'
        const okHeaders = headers && typeof headers === 'object' && Object.values(headers).every((v) => typeof v === 'string')
        if (typeof url !== 'string' || !okHeaders || (body !== undefined && (typeof body !== 'string' || body.length > LIMITS.requestBody)))
          throw new PluginError('fetch wants a URL, string headers and a string body', 'MALHA_BAD_REQUEST')
        await permit('fetch', `${verb} ${url}`, (p) => matchFetch(p, verb, url))
        const res = await fetch(url, { method: verb, headers: headers as Record<string, string>, body: body as string | undefined, redirect: 'manual', signal: AbortSignal.timeout(60_000) })
        return { status: res.status, statusText: res.statusText, headers: Object.fromEntries(res.headers), body: await readCapped(res, LIMITS.fetchBody) }
      }
      case 'readFile': {
        const { path } = msg
        const full = typeof path === 'string' ? resolveFile(path) : undefined
        if (!full) throw new PluginError('readFile wants an absolute path, or one starting with ~/', 'MALHA_BAD_REQUEST')
        // A declared file that does not exist is not worth a question.
        if (findRule(perms, 'files', (p) => matchFile(p, full)) && !existsSync(full)) throw new PluginError(`${path} does not exist`, 'MALHA_NOT_FOUND')
        await permit('files', full, (p) => matchFile(p, full))
        if (statSync(full).size > LIMITS.file) throw new PluginError(`${path} is larger than 10 MB`, 'MALHA_TOO_LARGE')
        return readFileSync(full, 'utf8')
      }
      case 'env': {
        const { name } = msg
        if (typeof name !== 'string') throw new PluginError('env wants a variable name', 'MALHA_BAD_REQUEST')
        // Nor is a declared variable that is not set.
        if (findRule(perms, 'env', (p) => matchEnv(p, name)) && process.env[name] === undefined) return null
        await permit('env', name, (p) => matchEnv(p, name))
        return process.env[name] ?? null
      }
      default:
        throw new PluginError(`unknown request "${op}"`, 'MALHA_BAD_REQUEST')
    }
  }

  const argv = sandboxArgv(iso, plugin.dir)
  const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: {}, cwd: plugin.dir, windowsHide: true })
  const label = opts.run.kind === 'command' ? opts.run.name : opts.run.kind

  return new Promise((resolve, reject) => {
    let settled = false
    let printed = 0
    let stderrTail = ''
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clock?.clear()
      if (child.exitCode === null) child.kill('SIGKILL')
      fn()
    }
    clock = deadline(opts.timeoutMs ?? 300_000, () =>
      finish(() => reject(new PluginError(`${plugin.name} ${label} took longer than ${Math.round((opts.timeoutMs ?? 300_000) / 1000)} s and was stopped`, 'MALHA_TIMEOUT'))),
    )

    const lines = (stream: NodeJS.ReadableStream, isErr: boolean) => {
      let buffer = ''
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        if (isErr) stderrTail = (stderrTail + chunk).slice(-4000)
        buffer += chunk
        const parts = buffer.split('\n')
        buffer = parts.pop() ?? ''
        for (const line of parts) {
          printed += line.length
          if (printed <= LIMITS.output) opts.output?.(sanitize(line))
        }
      })
      stream.on('end', () => buffer && opts.output?.(sanitize(buffer)))
    }
    lines(child.stdout!, false)
    lines(child.stderr!, true)

    child.on('error', (e) => finish(() => reject(new PluginError(`could not start the plugin: ${e.message}`, 'MALHA_SPAWN'))))
    child.on('exit', (code) =>
      finish(() => reject(new PluginError(`${plugin.name} exited (code ${code}) before finishing${stderrTail.trim() ? `:\n${sanitize(stderrTail.trim())}` : ''}`, 'MALHA_EXIT'))),
    )
    child.on('message', (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return
      const msg = raw as Record<string, unknown>
      if (msg.t === 'done') return finish(() => resolve(msg.value ?? {}))
      if (msg.t === 'error') {
        const code = typeof msg.code === 'string' ? msg.code : 'MALHA_PLUGIN'
        return finish(() => reject(new PluginError(`${plugin.name} ${label} failed: ${sanitize(String(msg.message))}`, code)))
      }
      if (msg.t !== 'call' || typeof msg.id !== 'number' || typeof msg.op !== 'string') return
      const id = msg.id
      handle(msg.op, msg).then(
        (value) => !settled && child.connected && child.send({ t: 'reply', id, ok: true, value }),
        (e: unknown) => {
          const err = e instanceof PluginError ? e : new PluginError((e as Error).message ?? String(e), 'MALHA_FAILED')
          if (!settled && child.connected) child.send({ t: 'reply', id, ok: false, error: { code: err.code, message: err.message } })
        },
      )
    })

    child.send({
      t: 'start',
      entry: join(plugin.dir, plugin.manifest.main),
      run: opts.run,
      options: plugin.entry.options ?? {},
      args: opts.args ?? [],
      input: opts.input,
      today: today(),
    })
  })
}
