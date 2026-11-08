import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyAccepted, AREAS, areaOf, runChecks, type CheckFinding } from '../core/check.ts'
import type { LiveNode } from '../core/live.ts'
import { SEVERITIES, type SecurityScan, type Severity } from '../core/security.ts'
import { runPlugin, Session } from '../plugins/host.ts'
import { cleanLive } from '../plugins/live.ts'
import { loadPlugins } from '../plugins/project.ts'
import type { CheckReport, NotifyResult } from '../plugins/sdk.ts'
import { c, pluginLine, terminalAsker } from '../plugins/terminal.ts'
import { loadTopology } from './load.ts'
import { display, scanPath, stateDir } from './paths.ts'

export interface CheckOptions {
  live: boolean
  notify: boolean
  digest: boolean
  json: boolean
  failOn: 'critical' | 'warning' | 'none'
  /** Lowest vulnerability severity to report. */
  vulns: Severity
}

interface Sent {
  level: string
  title: string
  at: string
}
interface State {
  sent: Record<string, Sent>
}

const statePath = (file: string) => join(stateDir(file), 'check-state.json')

function readState(file: string): State {
  try {
    return JSON.parse(readFileSync(statePath(file), 'utf8')) as State
  } catch {
    return { sent: {} }
  }
}

function readScan(file: string): SecurityScan | null {
  try {
    return existsSync(scanPath(file)) ? (JSON.parse(readFileSync(scanPath(file), 'utf8')) as SecurityScan) : null
  } catch {
    return null
  }
}

/** One refresh from every live plugin, for the node checks. */
async function liveOnce(file: string, nodeIds: Set<string>) {
  const out: Record<string, LiveNode> = {}
  const session = new Session()
  for (const p of loadPlugins(file)) {
    if (!p.plugin?.manifest.live || p.plugin.entry.live === false) continue
    try {
      const data = await runPlugin({ file, plugin: p.plugin, run: { kind: 'live' }, asker: terminalAsker(), session, output: pluginLine(p.name), timeoutMs: 60_000 })
      for (const [id, n] of Object.entries(cleanLive(data, nodeIds))) out[id] = { ...out[id], ...n }
      console.error(c.dim(`live data from ${p.name}`))
    } catch (e) {
      console.error(c.yellow(`${p.name}: ${(e as Error).message}; using the sampled values`))
    }
  }
  return out
}

const MARK = { critical: c.red('critical'), warning: c.yellow('warning ') }
/** Vulnerabilities shown per run; the rest are in --json and the Security tab. */
const SHOWN = 10

function print(project: string, open: CheckFinding[], accepted: (CheckFinding & { why: string })[]) {
  const critical = open.filter((f) => f.severity === 'critical').length
  console.log(`${c.bold(project)}: ${critical} critical, ${open.length - critical} warning(s)${accepted.length ? `, ${accepted.length} accepted` : ''}`)
  if (!open.length) console.log(`\n  ${c.green('Nothing needs you.')}`)
  for (const area of AREAS) {
    const items = open.filter((f) => areaOf(f) === area.name)
    if (!items.length) continue
    console.log(`\n${c.bold(area.name)}`)
    const vulns = items.filter((f) => f.check === 'vulnerability')
    const shown = [...items.filter((f) => f.check !== 'vulnerability'), ...vulns.slice(0, SHOWN)]
    for (const f of shown) {
      console.log(`  ${MARK[f.severity]}  ${f.title}`)
      if (f.detail) console.log(`            ${c.dim(f.detail)}`)
    }
    if (vulns.length > SHOWN) console.log(c.dim(`  … and ${vulns.length - SHOWN} more advisories, each in fewer repos. All of them: malha check --json, or the Security tab of malha dev.`))
  }
  if (accepted.length) {
    console.log(`\n${c.dim('Accepted')}`)
    for (const f of accepted) console.log(c.dim(`  ${f.title}: ${f.why}`))
  }
}

/**
 * Send what is new (or worse) since the last notice, and what was announced and is gone now, to
 * every notifier plugin. Remembers what was sent in .malha/check-state.json, only once a notifier
 * took it, so a failed send is tried again next time.
 */
export async function notify(file: string, project: string, open: CheckFinding[], acceptedIds: Set<string>, digest: boolean) {
  const state = readState(file)
  const findings = digest ? open : open.filter((f) => state.sent[f.id]?.level !== f.level)
  const openIds = new Set(open.map((f) => f.id))
  const gone = Object.entries(state.sent).filter(([id]) => !openIds.has(id))
  const resolved = gone.filter(([id]) => !acceptedIds.has(id)).map(([id, s]) => ({ id, title: s.title }))
  if (!findings.length && !resolved.length) {
    console.log('\nNothing new to announce.')
    for (const [id] of gone) delete state.sent[id]
    save(file, state)
    return []
  }
  const notifiers = loadPlugins(file).filter((p) => p.plugin?.manifest.notify && p.plugin.entry.notify !== false)
  if (!notifiers.length) throw new Error('No notifier plugin in malha.plugins.json. Add one: malha plugin add discord (or slack)')
  const report: CheckReport = { project, command: `malha check ${display(file)}`, open: open.length, findings, resolved, digest }
  const results: { name: string; result?: NotifyResult; error?: string }[] = []
  for (const p of notifiers) {
    try {
      const result = (await runPlugin({ file, plugin: p.plugin!, run: { kind: 'notify' }, input: report, asker: terminalAsker(), output: pluginLine(p.name), timeoutMs: 60_000 })) as NotifyResult
      results.push({ name: p.name, result })
    } catch (e) {
      results.push({ name: p.name, error: (e as Error).message })
    }
  }
  for (const r of results) console.log(`${r.name}: ${r.error ? c.red(r.error) : r.result?.sent ? c.green(r.result.message ?? 'sent') : c.yellow(r.result?.message ?? 'not sent')}`)
  if (!results.some((r) => r.result?.sent)) {
    process.exitCode = 1
    console.error('Nothing was sent; the next run tries again.')
    return results
  }
  const at = new Date().toISOString()
  for (const f of open) if (!state.sent[f.id] || state.sent[f.id].level !== f.level || digest) state.sent[f.id] = { level: f.level, title: f.title, at }
  for (const [id] of gone) delete state.sent[id]
  save(file, state)
  console.log(`Announced ${findings.length} finding(s)${resolved.length ? ` and ${resolved.length} resolved` : ''}.`)
  return results
}

function save(file: string, state: State) {
  mkdirSync(stateDir(file), { recursive: true })
  if (!existsSync(join(stateDir(file), '.gitignore'))) writeFileSync(join(stateDir(file), '.gitignore'), '*\n')
  writeFileSync(statePath(file), `${JSON.stringify(state, null, 2)}\n`)
}

/** `malha check`: what in the map needs a person. */
export async function check(file: string, opts: CheckOptions) {
  const { data, errors } = loadTopology(file)
  if (!data) {
    for (const e of errors) console.error(`error ${e}`)
    throw new Error(`${display(file)} is invalid; fix it first (malha validate)`)
  }
  const live = opts.live ? await liveOnce(file, new Set(data.nodes.map((n) => n.id))) : undefined
  const severities = SEVERITIES.slice(0, SEVERITIES.indexOf(opts.vulns) + 1)
  const { open, accepted } = applyAccepted(runChecks(data, { scan: readScan(file), live, severities }), data.accepted)
  if (opts.json) console.log(JSON.stringify({ project: data.meta.name, open, accepted }, null, 2))
  else print(data.meta.name, open, accepted)
  if (opts.notify || opts.digest) await notify(file, data.meta.name, open, new Set(accepted.map((f) => f.id)), opts.digest)
  const failing = opts.failOn === 'none' ? [] : open.filter((f) => opts.failOn === 'warning' || f.severity === 'critical')
  if (failing.length) process.exitCode = 1
}
