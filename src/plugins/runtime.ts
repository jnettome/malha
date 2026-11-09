// The plugin process: lock down, then load the plugin and run one command (or one live refresh),
// with a `ctx` whose every method is a request to Malha over the IPC channel. Malha treats this
// process as untrusted: it checks each request itself, whatever this file does.
import './lockdown.ts'
import { pathToFileURL } from 'node:url'
import type { AnalyticsRequest, CheckReport, CommandResult, FetchInit, LinkRequest, LiveData, NotifyResult, Plugin, PluginContext, Topology } from './sdk.ts'

interface Start {
  t: 'start'
  entry: string
  run: { kind: 'command'; name: string } | { kind: 'live' } | { kind: 'notify' } | { kind: 'analytics' } | { kind: 'link' }
  input?: unknown
  options: Record<string, unknown>
  args: string[]
  today: string
}

type Reply = { t: 'reply'; id: number; ok: true; value: unknown } | { t: 'reply'; id: number; ok: false; error: { code: string; message: string } }

const send = (msg: unknown) => new Promise<void>((resolve) => process.send!(msg, () => resolve()))
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
let next = 0

function call<T>(op: string, payload: Record<string, unknown> = {}): Promise<T> {
  const id = ++next
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    void send({ t: 'call', id, op, ...payload })
  })
}

function context(start: Start): PluginContext {
  return {
    options: start.options,
    args: start.args,
    today: start.today,
    topology: () => call<Topology>('topology'),
    exec: (command, args) => call('exec', { command, args }),
    readFile: (path) => call('readFile', { path }),
    env: (name) => call<string | null>('env', { name }).then((v) => v ?? undefined),
    async fetch(url: string, init: FetchInit = {}) {
      const r = await call<{ status: number; statusText: string; headers: Record<string, string>; body: string }>('fetch', {
        url: String(url),
        method: init.method ?? 'GET',
        headers: init.headers ?? {},
        body: init.body,
      })
      const empty = r.status === 204 || r.status === 205 || r.status === 304 || r.status < 200
      return new Response(empty ? null : r.body, { status: r.status, statusText: r.statusText, headers: r.headers })
    },
  }
}

async function run(start: Start) {
  const ctx = context(start)
  // Libraries that call fetch() go through Malha too.
  ;(globalThis as { fetch: unknown }).fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    const headers = Object.fromEntries(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)))
    const body = typeof init?.body === 'string' ? init.body : undefined
    return ctx.fetch(url, { method: init?.method ?? (input instanceof Request ? input.method : 'GET'), headers, body })
  }
  const mod = (await import(pathToFileURL(start.entry).href)) as { default?: Plugin } & Plugin
  const plugin = mod.default ?? mod
  if (start.run.kind === 'analytics') {
    if (typeof plugin.analytics !== 'function') throw new Error('this plugin declares analytics but exports no analytics() function')
    return await plugin.analytics(ctx, start.input as AnalyticsRequest)
  }
  if (start.run.kind === 'link') {
    if (typeof plugin.link !== 'function') return { sources: [], notes: ['this plugin cannot match trackers to sources'] }
    return await plugin.link(ctx, start.input as LinkRequest)
  }
  if (start.run.kind === 'notify') {
    if (typeof plugin.notify !== 'function') throw new Error('this plugin declares notify but exports no notify() function')
    return (await plugin.notify(ctx, start.input as CheckReport)) satisfies NotifyResult
  }
  if (start.run.kind === 'live') {
    if (typeof plugin.live !== 'function') throw new Error('this plugin declares live data but exports no live() function')
    return (await plugin.live(ctx)) satisfies LiveData
  }
  const fn = plugin.commands?.[start.run.name]
  if (typeof fn !== 'function') throw new Error(`this plugin exports no command "${start.run.name}"`)
  return ((await fn(ctx)) ?? {}) satisfies CommandResult
}

process.on('message', (msg: Start | Reply) => {
  if (msg.t === 'reply') {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.ok) p.resolve(msg.value)
    else p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }))
    return
  }
  if (msg.t !== 'start') return
  run(msg).then(
    async (value) => {
      await send({ t: 'done', value: JSON.parse(JSON.stringify(value ?? {})) })
      process.exit(0)
    },
    async (e: unknown) => {
      const err = e instanceof Error ? e : new Error(String(e))
      await send({ t: 'error', message: err.message, code: (err as Error & { code?: string }).code, stack: err.stack })
      process.exit(1)
    },
  )
})
