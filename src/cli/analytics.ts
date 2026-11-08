import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { change, primaryResult, ranges, sourceId, type AnalyticsCache, type AnalyticsRequest, type AnalyticsSource, type Provider, type Trackers, type SourceResult, type TopItem } from '../core/analytics.ts'
import { runPlugin, Session, type Asker } from '../plugins/host.ts'
import { loadPlugins, type Resolved } from '../plugins/project.ts'
import type { LinkResult } from '../plugins/sdk.ts'
import { proposeChanges } from '../plugins/commands.ts'
import { c, pluginLine, terminalAsker } from '../plugins/terminal.ts'
import { loadTopology } from './load.ts'
import { display, stateDir } from './paths.ts'
import { findTrackers } from './trackers.ts'

export const analyticsPath = (file: string) => join(stateDir(file), 'analytics.json')

export function readAnalytics(file: string): AnalyticsCache | null {
  try {
    return existsSync(analyticsPath(file)) ? (JSON.parse(readFileSync(analyticsPath(file), 'utf8')) as AnalyticsCache) : null
  } catch {
    return null
  }
}

/** Analytics plugins in the project, by the provider each serves (the first one listed wins). */
function pluginsByProvider(file: string) {
  const out = new Map<Provider, Resolved>()
  for (const p of loadPlugins(file)) for (const provider of p.plugin?.manifest.analytics?.providers ?? []) if (!out.has(provider)) out.set(provider, p.plugin!)
  return out
}

// Plugins are untrusted: keep only well-formed numbers and short strings, for the sources asked for.
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)
const ratio = (v: unknown) => (num(v) !== undefined && (v as number) <= 1 ? (v as number) : undefined)
const text = (v: unknown, max = 300) => (typeof v === 'string' ? v.slice(0, max) : undefined)
const day = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined)
const totals = (t: unknown) => {
  if (!t || typeof t !== 'object') return undefined
  const o = t as Record<string, unknown>
  return { visitors: num(o.visitors), pageviews: num(o.pageviews), sessions: num(o.sessions), bounce_rate: ratio(o.bounce_rate), avg_duration: num(o.avg_duration) }
}
const top = (list: unknown): TopItem[] | undefined =>
  Array.isArray(list) ? list.slice(0, 25).flatMap((x) => (text(x?.key) !== undefined && num(x?.value) !== undefined ? [{ key: text(x.key)!, value: num(x.value)! }] : [])) : undefined
const search = (s: unknown) => {
  if (!s || typeof s !== 'object') return undefined
  const o = s as Record<string, unknown>
  const st = (v: unknown) => {
    const x = (v ?? {}) as Record<string, unknown>
    return { clicks: num(x.clicks) ?? 0, impressions: num(x.impressions) ?? 0, ctr: ratio(x.ctr) ?? 0, position: num(x.position) ?? 0 }
  }
  const rows = (list: unknown) => (Array.isArray(list) ? list.slice(0, 25).flatMap((x) => (text(x?.key) ? [{ key: text(x.key)!, ...st(x) }] : [])) : [])
  return {
    totals: st(o.totals),
    previous: o.previous ? st(o.previous) : undefined,
    series: Array.isArray(o.series) ? o.series.slice(0, 400).flatMap((p) => (day(p?.date) ? [{ date: p.date, clicks: num(p.clicks) ?? 0, impressions: num(p.impressions) ?? 0 }] : [])) : [],
    queries: rows(o.queries),
    pages: rows(o.pages),
  }
}

export function cleanResults(raw: unknown, request: AnalyticsRequest): SourceResult[] {
  const asked = new Map(request.sources.map((s) => [`${s.app}|${sourceId(s)}`, s]))
  const out = new Map<string, SourceResult>()
  type Raw = Record<string, unknown> & { top?: Record<string, unknown>; series?: unknown }
  const results = (raw as { results?: unknown } | undefined)?.results
  for (const r of (Array.isArray(results) ? results : []) as Raw[]) {
    if (!r || typeof r !== 'object') continue
    const key = `${r?.app}|${r?.provider}:${r?.id}`
    const source = asked.get(key)
    if (!source || out.has(key)) continue
    out.set(key, {
      app: source.app,
      provider: source.provider,
      id: String(source.id),
      host: source.host,
      primary: source.primary,
      ok: r.ok === true,
      error: text(r.error),
      totals: totals(r.totals),
      previous: totals(r.previous),
      series: Array.isArray(r.series) ? r.series.slice(0, 400).flatMap((p: Record<string, unknown>) => (day(p?.date) ? [{ date: p.date as string, visitors: num(p.visitors), pageviews: num(p.pageviews) }] : [])) : undefined,
      top: r.top ? { pages: top(r.top.pages), referrers: top(r.top.referrers), countries: top(r.top.countries), devices: top(r.top.devices) } : undefined,
      search: source.provider === 'search-console' ? search(r.search) : undefined,
    })
  }
  for (const [key, s] of asked) if (!out.has(key)) out.set(key, { app: s.app, provider: s.provider, id: String(s.id), host: s.host, primary: s.primary, ok: false, error: 'the plugin returned nothing for this source' })
  return [...out.values()]
}

export interface RefreshOptions {
  days: number
  timezone: string
  asker?: Asker
  session?: Session
  log?: (line: string) => void
}

/** Ask each analytics plugin for its sources' traffic and write .malha/analytics.json. */
/** Where an app's Umami script comes from, put the way options.hosts wants it. */
function umamiServers(t: Trackers): string {
  const where = new Set<string>()
  for (const u of t.umami) {
    let url: URL
    try {
      url = new URL(u.script)
    } catch {
      continue
    }
    if (url.hostname === 'cloud.umami.is') where.add('Umami Cloud (https://api.umami.is)')
    else if (t.hostnames.includes(url.hostname)) where.add('its own domain (a proxy: options.hosts is the Umami server behind it)')
    else where.add(url.origin)
  }
  return [...where].join(', ') || 'a script Malha could not place'
}

/** Which PostHog cloud an app sends to, when its page says. */
function posthogWhere(t: Trackers): string {
  const hosts = t.posthog.map((p) => p.host ?? '')
  if (hosts.some((h) => /\/\/(eu|eu\.i)\.posthog\.com/.test(h))) return ' (EU cloud: https://eu.posthog.com)'
  if (hosts.some((h) => /\/\/(us|us\.i|app)\.posthog\.com/.test(h))) return ' (US cloud: https://us.posthog.com)'
  const own = hosts.find((h) => h)
  return own ? ` (${own})` : ''
}

export async function refreshAnalytics(file: string, opts: RefreshOptions): Promise<AnalyticsCache> {
  const { data, errors } = loadTopology(file)
  if (!data) throw new Error(`${display(file)} is invalid: ${errors[0]}`)
  const log = opts.log ?? ((l: string) => console.log(l))
  const { range, previous } = ranges(opts.days)
  const byProvider = pluginsByProvider(file)
  const sources = (data.apps ?? []).flatMap((a) => (a.analytics ?? []).map((s) => ({ ...s, app: a.id, hostnames: a.domains ?? [] })))
  if (!sources.length) throw new Error('No app lists analytics sources yet. Run malha analytics detect, or add them under each app (docs/analytics.md).')
  const results: SourceResult[] = []
  const session = opts.session ?? new Session()
  for (const provider of new Set(sources.map((s) => s.provider))) {
    const mine = sources.filter((s) => s.provider === provider)
    const plugin = byProvider.get(provider)
    if (!plugin) {
      for (const s of mine) results.push({ app: s.app, provider, id: String(s.id), host: s.host, primary: s.primary, ok: false, error: `no plugin for ${provider}: malha plugin add ${provider === 'ga4' || provider === 'search-console' ? 'google' : provider}` })
      continue
    }
    const request: AnalyticsRequest = { range, previous, timezone: opts.timezone, sources: mine }
    try {
      log(c.dim(`${plugin.name}: ${mine.length} ${provider} source(s)…`))
      const raw = await runPlugin({ file, plugin, run: { kind: 'analytics' }, input: request, asker: opts.asker ?? terminalAsker(), session, output: pluginLine(plugin.name), timeoutMs: 300_000 })
      results.push(...cleanResults(raw, request))
    } catch (e) {
      for (const s of mine) results.push({ app: s.app, provider, id: String(s.id), host: s.host, primary: s.primary, ok: false, error: (e as Error).message })
    }
  }
  const cache: AnalyticsCache = { fetched: new Date().toISOString(), days: opts.days, range, previous, results }
  mkdirSync(stateDir(file), { recursive: true })
  if (!existsSync(join(stateDir(file), '.gitignore'))) writeFileSync(join(stateDir(file), '.gitignore'), '*\n')
  writeFileSync(analyticsPath(file), `${JSON.stringify(cache, null, 2)}\n`)
  return cache
}

const fmt = (n: number | undefined) => (n === undefined ? '—' : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)))
const pct = (x: number | undefined) => (x === undefined ? '' : `${x >= 0 ? '+' : ''}${Math.round(x * 100)}%`)

/** The table `refresh` and plain `malha analytics` print. */
export function printSummary(cache: AnalyticsCache, appNames: Map<string, string>) {
  console.log(`\n${c.bold('Traffic')} ${cache.range.from} → ${cache.range.to} (${cache.days} days), against the ${cache.days} days before\n`)
  const apps = [...new Set(cache.results.map((r) => r.app))]
  const rows = apps.map((app) => {
    const mine = cache.results.filter((r) => r.app === app)
    const main = primaryResult(mine)
    const sc = mine.find((r) => r.provider === 'search-console' && r.ok)
    return { app, main, sc, failed: mine.filter((r) => !r.ok) }
  })
  rows.sort((a, b) => (b.main?.totals?.visitors ?? -1) - (a.main?.totals?.visitors ?? -1))
  for (const r of rows) {
    const name = (appNames.get(r.app) ?? r.app).padEnd(22)
    const v = r.main ? `${fmt(r.main.totals?.visitors).padStart(6)} visitors ${pct(change(r.main.totals?.visitors, r.main.previous?.visitors)).padEnd(6)} ${c.dim(r.main.provider)}` : c.dim('no traffic source answered'.padEnd(32))
    const s = r.sc?.search ? `  ${fmt(r.sc.search.totals.clicks).padStart(5)} search clicks, position ${r.sc.search.totals.position.toFixed(1)}` : ''
    console.log(`  ${name} ${v}${s}`)
    for (const f of r.failed) console.log(`  ${''.padEnd(22)} ${c.yellow(`${f.provider} ${f.id}: ${f.error ?? 'failed'}`)}`)
  }
}

export async function analytics(file: string, sub: string | undefined, opts: { days: number; timezone: string; yes: boolean; dryRun: boolean }) {
  const { data, errors } = loadTopology(file)
  if (!data) throw new Error(`${display(file)} is invalid: ${errors[0]}`)
  const names = new Map((data.apps ?? []).map((a) => [a.id, a.name]))
  if (sub === 'refresh') {
    const cache = await refreshAnalytics(file, { days: opts.days, timezone: opts.timezone })
    printSummary(cache, names)
    console.log(c.dim(`\nWrote ${display(analyticsPath(file))}. The Traffic tab of malha dev shows it.`))
    if (cache.results.every((r) => !r.ok)) process.exitCode = 1
    return
  }
  if (sub === 'detect') return detect(file, opts)
  if (sub && sub !== 'show') throw new Error('usage: malha analytics [show|refresh|detect] [file]')
  const cache = readAnalytics(file)
  if (!cache) return console.log(`No traffic yet. Run: malha analytics refresh ${display(file)}`)
  printSummary(cache, names)
  console.log(c.dim(`\nFetched ${cache.fetched.replace('T', ' ').slice(0, 16)} UTC.`))
}

/** Find trackers on each app's pages, let the plugins match them to sources, and propose them. */
async function detect(file: string, opts: { yes: boolean; dryRun: boolean }) {
  const { data } = loadTopology(file)
  if (!data) return
  const names = new Set((data.apps ?? []).map((a) => a.id))
  console.log(c.dim('Reading each app’s public pages for trackers…'))
  const trackers = await findTrackers(data, (l) => console.log(`  ${l}`))
  const plugins = [...new Set(pluginsByProvider(file).values())]
  const proposed = new Map<string, AnalyticsSource[]>()
  const notes: string[] = []
  const session = new Session()
  for (const plugin of plugins) {
    try {
      const raw = (await runPlugin({ file, plugin, run: { kind: 'link' }, input: { trackers }, asker: terminalAsker(), session, output: pluginLine(plugin.name), timeoutMs: 300_000 })) as LinkResult
      for (const n of (raw?.notes ?? []).slice(0, 50)) if (typeof n === 'string') notes.push(`${plugin.name}: ${n.slice(0, 300)}`)
      for (const { app, source } of raw?.sources ?? []) {
        if (!names.has(app) || !source || !plugin.manifest.analytics!.providers.includes(source.provider)) continue
        const clean: AnalyticsSource = { provider: source.provider, id: typeof source.id === 'number' ? source.id : String(source.id).slice(0, 200), ...(typeof source.host === 'string' && /^https?:\/\/[^/\s]+$/.test(source.host) ? { host: source.host } : {}) }
        proposed.set(app, [...(proposed.get(app) ?? []), clean])
      }
    } catch (e) {
      notes.push(`${plugin.name}: ${(e as Error).message}`)
    }
  }
  const covered = new Set(plugins.flatMap((p) => p.manifest.analytics!.providers))
  for (const t of trackers) {
    if (t.umami.length && !covered.has('umami')) notes.push(`${t.app}: loads Umami from ${umamiServers(t)}; malha plugin add umami, with that server in options.hosts, to read it`)
    if (t.ga4.length && !covered.has('ga4')) notes.push(`${t.app}: loads Google Analytics ${t.ga4.join(', ')}; malha plugin add google to read it`)
    if (t.posthog.length && !covered.has('posthog')) notes.push(`${t.app}: loads PostHog${posthogWhere(t)}; malha plugin add posthog to read it`)
    if (t.gtm.length && !t.ga4.length) notes.push(`${t.app}: loads Tag Manager ${t.gtm.join(', ')}; the GA4 property behind it can't be seen from the page, so add it by hand`)
  }
  if (notes.length) console.log(`\n${notes.map((n) => `  ${c.yellow('·')} ${n}`).join('\n')}`)
  const changes = []
  for (const app of data.apps ?? []) {
    const add = (proposed.get(app.id) ?? []).filter((s, i, all) => !(app.analytics ?? []).some((x) => sourceId(x) === sourceId(s)) && all.findIndex((y) => sourceId(y) === sourceId(s)) === i)
    if (add.length) changes.push({ update: 'apps', id: app.id, set: { analytics: [...(app.analytics ?? []), ...add] }, why: add.map((s) => s.provider).join(', ') })
  }
  if (!changes.length) return console.log(`\n  Nothing new to add to ${display(file)}.`)
  await proposeChanges(file, 'malha analytics detect', changes, opts)
}
