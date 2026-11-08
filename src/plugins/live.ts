import { randomUUID } from 'node:crypto'
import { readAnalytics, refreshAnalytics } from '../cli/analytics.ts'
import { loadTopology } from '../cli/load.ts'
import type { Ask, LiveSnapshot, PluginStatus } from '../core/live.ts'
import { PluginError, runPlugin, Session, type Answer, type Asker } from './host.ts'
import { loadPlugin, loadPlugins } from './project.ts'
import { isolation } from './sandbox.ts'
import type { LiveData, LiveNode } from './sdk.ts'

export type { LiveSnapshot }

// Live data for `malha dev`: runs each live plugin on its interval and keeps the latest values,
// which the viewer shows in place of the sampled ones. Questions a plugin raises go to the open
// page, and an answer is good until `malha dev` stops (or always, if the person says so).

const STATUSES = new Set(['active', 'idle', 'degraded', 'planned', 'retired'])

/** Keep only well-formed values for nodes the topology has. */
export function cleanLive(data: unknown, nodeIds: Set<string>) {
  const out: Record<string, LiveNode> = {}
  const nodes = (data as LiveData | undefined)?.nodes
  if (!nodes || typeof nodes !== 'object') return out
  const pct = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v))) : undefined)
  for (const [id, raw] of Object.entries(nodes)) {
    if (!nodeIds.has(id) || !raw || typeof raw !== 'object') continue
    const v: LiveNode = {}
    const cpu = pct(raw.cpu_pct)
    const memory = pct(raw.memory_pct)
    if (cpu !== undefined) v.cpu_pct = cpu
    if (memory !== undefined) v.memory_pct = memory
    if (Number.isInteger(raw.pods) && raw.pods! >= 0 && raw.pods! <= 100_000) v.pods = raw.pods
    if (typeof raw.status === 'string' && STATUSES.has(raw.status)) v.status = raw.status
    if (Object.keys(v).length) out[id] = v
  }
  return out
}

export interface LiveOptions {
  /** Send an event to every open page. */
  broadcast(event: string, data: unknown): void
  log(line: string): void
  /** False when the server is reachable from other machines: then only `malha plugin allow` approves. */
  browserApprovals: boolean
}

export function createLive(file: string, opts: LiveOptions) {
  const session = new Session()
  const statuses = new Map<string, PluginStatus>()
  const values = new Map<string, { at: string; nodes: Record<string, LiveNode> }>()
  const asks = new Map<string, { ask: Ask; resolve: (a: Answer) => void }>()
  const timers = new Set<NodeJS.Timeout>()
  let network = ''
  let closed = false

  const snapshot = (): LiveSnapshot => {
    const nodes: LiveSnapshot['nodes'] = {}
    for (const [plugin, v] of values) for (const [id, n] of Object.entries(v.nodes)) nodes[id] = { ...nodes[id], ...n, plugin, at: v.at }
    return { plugins: [...statuses.values()], nodes, asks: [...asks.values()].map((a) => a.ask), network }
  }
  const push = () => !closed && opts.broadcast('live', snapshot())
  const status = (name: string, patch: Partial<PluginStatus>) => {
    statuses.set(name, { ...statuses.get(name)!, ...patch })
    push()
  }

  /** `key` is the status entry that shows "waiting for you" (the plugin's own, or "analytics"). */
  const askerFor = (name: string, key = name): Asker => ({
    ask(question) {
      if (!opts.browserApprovals) {
        opts.log(`${name}: needs approval for ${question.detail}. This server is reachable from other machines, so approve in a terminal: malha plugin allow ${name}`)
        return Promise.resolve('deny')
      }
      const id = randomUUID()
      opts.log(`${name} is asking in the browser: ${question.kind} ${question.detail}`)
      status(key, { state: 'asking', message: `waiting for you to answer in the browser` })
      return new Promise<Answer>((resolve) => {
        asks.set(id, { ask: { id, question }, resolve })
        push()
      })
    },
  })

  async function tick(name: string) {
    if (closed) return
    let every = statuses.get(name)?.every ?? 60
    try {
      const plugin = loadPlugin(file, name)
      every = plugin.manifest.live?.every ?? every
      const result = await runPlugin({ file, plugin, run: { kind: 'live' }, asker: askerFor(name), session, output: (line) => opts.log(`${name} │ ${line}`), timeoutMs: 60_000 })
      const ids = new Set((loadTopology(file).data?.nodes ?? []).map((n) => n.id))
      const at = new Date().toISOString()
      values.set(name, { at, nodes: cleanLive(result, ids) })
      status(name, { state: 'ok', message: undefined, at, every })
    } catch (e) {
      const declined = e instanceof PluginError && e.code === 'MALHA_DENIED'
      const message = (e as Error).message
      opts.log(`${name}: ${message}`)
      if (declined) {
        status(name, { state: 'stopped', message: `${message}. Restart malha dev to be asked again.` })
        return
      }
      status(name, { state: 'error', message })
    }
    if (closed) return
    const timer = setTimeout(() => {
      timers.delete(timer)
      void tick(name)
    }, every * 1000)
    timers.add(timer)
  }

  // Traffic: refresh when it is older than ANALYTICS_EVERY, through the same questions in the page.
  const ANALYTICS_EVERY = 6 * 3600
  async function analyticsTick() {
    if (closed) return
    const sources = (loadTopology(file).data?.apps ?? []).some((a) => a.analytics?.length)
    const plugins = loadPlugins(file).filter((p) => p.plugin?.manifest.analytics)
    if (sources && plugins.length) {
      const age = (Date.now() - Date.parse(readAnalytics(file)?.fetched ?? '1970-01-01')) / 1000
      const name = plugins.map((p) => p.name).join(', ')
      statuses.set('analytics', { name: `traffic (${name})`, every: ANALYTICS_EVERY, state: age < ANALYTICS_EVERY ? 'ok' : 'starting', at: readAnalytics(file)?.fetched })
      if (age >= ANALYTICS_EVERY) {
        opts.log(`traffic: refreshing (${name})`)
        try {
          const asker: Asker = { ask: (q) => askerFor(q.plugin, 'analytics').ask(q) }
          const cache = await refreshAnalytics(file, { days: readAnalytics(file)?.days ?? 30, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, asker, session, log: (l) => opts.log(`traffic │ ${l}`) })
          const failed = cache.results.filter((r) => !r.ok).length
          status('analytics', { state: failed === cache.results.length ? 'error' : 'ok', at: cache.fetched, message: failed ? `${failed} of ${cache.results.length} sources failed; malha analytics shows why` : undefined })
        } catch (e) {
          status('analytics', { state: 'error', message: (e as Error).message })
        }
      } else push()
    }
    if (closed) return
    const timer = setTimeout(() => {
      timers.delete(timer)
      void analyticsTick()
    }, 15 * 60 * 1000)
    timers.add(timer)
  }

  void isolation().then((iso) => {
    network = iso.network
    void analyticsTick()
    for (const entry of loadPlugins(file)) {
      if (!entry.plugin) {
        statuses.set(entry.name, { name: entry.name, every: 0, state: 'error', message: entry.error })
        opts.log(`${entry.name}: ${entry.error}`)
        continue
      }
      const live = entry.plugin.manifest.live
      if (!live || entry.plugin.entry.live === false) continue
      statuses.set(entry.name, { name: entry.name, every: live.every, state: 'starting' })
      opts.log(`${entry.name}: live data every ${live.every} s`)
      void tick(entry.name)
    }
    push()
  })

  return {
    snapshot,
    /** Settle an open question; false if there is no such question (already answered, say). */
    answer(id: string, answer: Answer) {
      const open = asks.get(id)
      if (!open) return false
      asks.delete(id)
      open.resolve(answer)
      const name = open.ask.question.plugin
      if (statuses.get(name)?.state === 'asking') status(name, { state: 'starting', message: undefined })
      else if (statuses.get('analytics')?.state === 'asking' && ![...asks.values()].length) status('analytics', { state: 'starting', message: undefined })
      else push()
      return true
    },
    close() {
      closed = true
      for (const t of timers) clearTimeout(t)
      for (const { resolve } of asks.values()) resolve('deny')
      asks.clear()
    },
  }
}

export type Live = ReturnType<typeof createLive>
