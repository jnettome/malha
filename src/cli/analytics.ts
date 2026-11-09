import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { change, customRange, DEFAULT_PERIOD, isRelative, mainResult, searchResult, MAX_CUSTOM, normalizeAnalytics, pickPeriod, PRESETS, rangeKey, ranges, sourceId, TOP_LISTS, unlistedHosts, type AnalyticsCache, type AnalyticsFile, type AnalyticsRequest, type AnalyticsSource, type DateRange, type Provider, type SourceResult, type TopItem, type Trackers } from '../core/analytics.ts'
import { runPlugin, Session, type Asker } from '../plugins/host.ts'
import { loadPlugins, type Resolved } from '../plugins/project.ts'
import type { LinkResult } from '../plugins/sdk.ts'
import { proposeChanges } from '../plugins/commands.ts'
import { c, pluginLine, terminalAsker } from '../plugins/terminal.ts'
import { loadTopology } from './load.ts'
import { display, stateDir } from './paths.ts'
import { findTrackers } from './trackers.ts'

export const analyticsPath = (file: string) => join(stateDir(file), 'analytics.json')

export function readAnalytics(file: string): AnalyticsFile | null {
  try {
    return existsSync(analyticsPath(file)) ? normalizeAnalytics(JSON.parse(readFileSync(analyticsPath(file), 'utf8'))) : null
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
  const points = (list: unknown) => (Array.isArray(list) ? list.slice(0, 400).flatMap((p) => (day(p?.date) ? [{ date: p.date as string, clicks: num(p.clicks) ?? 0, impressions: num(p.impressions) ?? 0 }] : [])) : undefined)
  return {
    totals: st(o.totals),
    previous: o.previous ? st(o.previous) : undefined,
    series: points(o.series) ?? [],
    previousSeries: points(o.previousSeries),
    queries: rows(o.queries),
    pages: rows(o.pages),
  }
}

const series = (list: unknown) =>
  Array.isArray(list) ? list.slice(0, 400).flatMap((p: Record<string, unknown>) => (day(p?.date) ? [{ date: p.date as string, visitors: num(p.visitors), pageviews: num(p.pageviews) }] : [])) : undefined

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
      note: text(r.note),
      totals: totals(r.totals),
      previous: totals(r.previous),
      series: series(r.series),
      previousSeries: series(r.previousSeries),
      top: r.top ? Object.fromEntries(TOP_LISTS.map((k) => [k, top(r.top![k])])) : undefined,
      allHosts: top(r.allHosts),
      search: source.provider === 'search-console' ? search(r.search) : undefined,
    })
  }
  for (const [key, s] of asked) if (!out.has(key)) out.set(key, { app: s.app, provider: s.provider, id: String(s.id), host: s.host, primary: s.primary, ok: false, error: 'the plugin returned nothing for this source' })
  return [...out.values()]
}

export interface RefreshOptions {
  /** Periods to fetch: a number of days ending yesterday, or a fixed range. Default: the presets
   *  (7, 30 and 90 days) and any other number of days already in the file. */
  periods?: (number | DateRange)[]
  timezone: string
  asker?: Asker
  session?: Session
  log?: (line: string) => void
  today?: Date
}

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

/** The server a plugin reads by default (its first options.hosts), for links to the dashboard. */
const defaultHost = (plugin: Resolved) => [plugin.entry.options?.hosts ?? []].flat().map(String).find((h) => /^https?:\/\/[^/\s?#]+\/?$/.test(h))?.replace(/\/+$/, '')

/** Ask each analytics plugin for every period's traffic, and write them into .malha/analytics.json
 *  beside the periods already there. */
export async function refreshAnalytics(file: string, opts: RefreshOptions): Promise<AnalyticsFile> {
  const before = readAnalytics(file)
  const relative = new Set([...PRESETS, ...(before?.periods ?? []).filter((p) => isRelative(p.key)).map((p) => p.days)])
  const wanted = opts.periods ?? [...relative].sort((a, b) => a - b)
  const session = opts.session ?? new Session()
  const fetched: AnalyticsCache[] = []
  for (const period of wanted) fetched.push(await fetchPeriod(file, period, { ...opts, session }))
  const keys = new Set(fetched.map((p) => p.key))
  const kept = (before?.periods ?? []).filter((p) => !keys.has(p.key))
  const custom = [...kept, ...fetched].filter((p) => !isRelative(p.key)).sort((a, b) => b.fetched.localeCompare(a.fetched)).slice(0, MAX_CUSTOM)
  const periods = [...kept, ...fetched].filter((p) => isRelative(p.key) || custom.includes(p)).sort((a, b) => Number(isRelative(b.key)) - Number(isRelative(a.key)) || a.days - b.days || a.range.from.localeCompare(b.range.from))
  const out: AnalyticsFile = { version: 2, periods }
  mkdirSync(stateDir(file), { recursive: true })
  if (!existsSync(join(stateDir(file), '.gitignore'))) writeFileSync(join(stateDir(file), '.gitignore'), '*\n')
  writeFileSync(analyticsPath(file), `${JSON.stringify(out)}\n`)
  return out
}

/** One period: every source, through its provider's plugin. */
async function fetchPeriod(file: string, period: number | DateRange, opts: RefreshOptions & { session: Session }): Promise<AnalyticsCache> {
  const { data, errors } = loadTopology(file)
  if (!data) throw new Error(`${display(file)} is invalid: ${errors[0]}`)
  const log = opts.log ?? ((l: string) => console.log(l))
  let key: string
  let days: number
  let range: DateRange
  let previous: DateRange
  if (typeof period === 'number') {
    ;({ range, previous } = ranges(period, opts.today))
    key = `${period}d`
    days = period
  } else {
    const r = customRange(period.from, period.to, opts.today)
    if ('error' in r) throw new Error(`${period.from} to ${period.to}: ${r.error}`)
    ;({ range, previous, days } = r)
    key = rangeKey(range)
  }
  const byProvider = pluginsByProvider(file)
  const sources = (data.apps ?? []).flatMap((a) => (a.analytics ?? []).map((s) => ({ ...s, app: a.id, hostnames: a.domains ?? [] })))
  if (!sources.length) throw new Error('No app lists analytics sources yet. Run malha analytics detect, or add them under each app (docs/analytics.md).')
  const results: SourceResult[] = []
  const session = opts.session
  for (const provider of new Set(sources.map((s) => s.provider))) {
    const mine = sources.filter((s) => s.provider === provider)
    const plugin = byProvider.get(provider)
    if (!plugin) {
      for (const s of mine) results.push({ app: s.app, provider, id: String(s.id), host: s.host, primary: s.primary, ok: false, error: `no plugin for ${provider}: malha plugin add ${provider === 'ga4' || provider === 'search-console' ? 'google' : provider}` })
      continue
    }
    const request: AnalyticsRequest = { range, previous, timezone: opts.timezone, sources: mine }
    try {
      log(c.dim(`${plugin.name}: ${mine.length} ${provider} source(s), ${range.from} to ${range.to}…`))
      const raw = await runPlugin({ file, plugin, run: { kind: 'analytics' }, input: request, asker: opts.asker ?? terminalAsker(), session, output: pluginLine(plugin.name), timeoutMs: 300_000 })
      const host = provider === 'umami' || provider === 'posthog' ? defaultHost(plugin) : undefined
      results.push(...cleanResults(raw, request).map((r) => (host && !r.host ? { ...r, host } : r)))
    } catch (e) {
      for (const s of mine) results.push({ app: s.app, provider, id: String(s.id), host: s.host, primary: s.primary, ok: false, error: (e as Error).message })
    }
  }
  // In each app's own order, so its first tracker listed is the one that counts (plugins run per
  // provider, which would otherwise decide it).
  const order = new Map(sources.map((s, i) => [`${s.app}|${sourceId(s)}`, i]))
  results.sort((a, b) => (order.get(`${a.app}|${sourceId(a)}`) ?? 0) - (order.get(`${b.app}|${sourceId(b)}`) ?? 0))
  return { key, fetched: new Date().toISOString(), days, range, previous, results }
}

const fmt = (n: number | undefined) => (n === undefined ? '—' : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)))
const pct = (x: number | undefined) => (x === undefined ? '' : `${x >= 0 ? '+' : ''}${Math.round(x * 100)}%`)

/** The table `refresh` and plain `malha analytics` print. */
export function printSummary(cache: AnalyticsCache, apps: { id: string; name: string; domains?: string[] }[]) {
  const appNames = new Map(apps.map((a) => [a.id, a.name]))
  console.log(`\n${c.bold('Traffic')} ${cache.range.from} → ${cache.range.to} (${cache.days} days), against the ${cache.days} days before\n`)
  const ids = [...new Set(cache.results.map((r) => r.app))]
  const rows = ids.map((app) => {
    const mine = cache.results.filter((r) => r.app === app)
    const main = mainResult(mine)
    const sc = searchResult(mine)
    return { app, main, sc, failed: mine.filter((r) => !r.ok), measured: mine.some((r) => r.provider !== 'search-console') }
  })
  rows.sort((a, b) => (b.main?.totals?.visitors ?? -1) - (a.main?.totals?.visitors ?? -1))
  for (const r of rows) {
    const name = (appNames.get(r.app) ?? r.app).padEnd(22)
    const v = r.main ? `${fmt(r.main.totals?.visitors).padStart(6)} visitors ${pct(change(r.main.totals?.visitors, r.main.previous?.visitors)).padEnd(6)} ${c.dim(r.main.parts ? `${r.main.provider} ×${r.main.parts.length}` : r.main.provider)}` : c.dim((r.measured ? 'no traffic source answered' : 'search only').padEnd(32))
    const s = r.sc?.search ? `  ${fmt(r.sc.search.totals.clicks).padStart(5)} search clicks, position ${r.sc.search.totals.position.toFixed(1)}` : ''
    console.log(`  ${name} ${v}${s}`)
    for (const f of r.failed) console.log(`  ${''.padEnd(22)} ${c.yellow(`${f.provider} ${f.id}: ${f.error ?? 'failed'}`)}`)
    for (const n of cache.results.filter((x) => x.app === r.app && x.ok && x.note)) console.log(`  ${''.padEnd(22)} ${c.yellow(`${n.provider} ${n.id}: ${n.note}`)}`)
  }
  const unlisted = unlistedHosts(cache.results, apps)
  if (unlisted.length) {
    console.log(`\n  ${c.yellow('Not counted:')} pageviews on hostnames no app lists. Add each to its app's domains to count it.`)
    for (const u of unlisted) console.log(`  ${c.yellow('·')} ${u.host.padEnd(28)} ${fmt(u.pageviews).padStart(6)} pageviews in ${u.provider} ${u.id} (${appNames.get(u.app) ?? u.app})`)
  }
}

export interface AnalyticsOptions {
  /** A number of days ending yesterday, or a fixed range (from and to), to fetch or to show. */
  days?: number
  from?: string
  to?: string
  timezone: string
  yes: boolean
  dryRun: boolean
}

export async function analytics(file: string, sub: string | undefined, opts: AnalyticsOptions) {
  const { data, errors } = loadTopology(file)
  if (!data) throw new Error(`${display(file)} is invalid: ${errors[0]}`)
  const apps = data.apps ?? []
  if ((opts.from === undefined) !== (opts.to === undefined)) throw new Error('--from and --to go together')
  if (opts.from && opts.days) throw new Error('give --days, or --from and --to, not both')
  const asked: number | DateRange | undefined = opts.from ? { from: opts.from, to: opts.to! } : opts.days
  const keyOf = (p: number | DateRange) => (typeof p === 'number' ? `${p}d` : rangeKey(p))
  if (sub === 'refresh') {
    const out = await refreshAnalytics(file, { periods: asked === undefined ? undefined : [asked], timezone: opts.timezone })
    const shown = pickPeriod(out, asked === undefined ? DEFAULT_PERIOD : keyOf(asked))!
    printSummary(shown, apps)
    console.log(c.dim(`\nWrote ${display(analyticsPath(file))}: ${out.periods.map((p) => p.key).join(', ')}. The Traffic tab of malha dev shows it.`))
    if (shown.results.every((r) => !r.ok)) process.exitCode = 1
    return
  }
  if (sub === 'detect') return detect(file, opts)
  if (sub && sub !== 'show') throw new Error('usage: malha analytics [show|refresh|detect] [file]')
  const all = readAnalytics(file)
  const cache = pickPeriod(all, asked === undefined ? undefined : keyOf(asked))
  if (!cache) return console.log(`No traffic yet. Run: malha analytics refresh ${display(file)}`)
  if (asked !== undefined && cache.key !== keyOf(asked)) return console.log(`No ${keyOf(asked)} period yet. Run: malha analytics refresh ${display(file)} ${typeof asked === 'number' ? `--days ${asked}` : `--from ${asked.from} --to ${asked.to}`}`)
  printSummary(cache, apps)
  console.log(c.dim(`\nFetched ${cache.fetched.replace('T', ' ').slice(0, 16)} UTC. Periods: ${all!.periods.map((p) => p.key).join(', ')}.`))
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
  // A website, project or property belongs to one app: never propose one another app has, and ask
  // when two apps claim the same one (a tracker shared by two sites).
  const owner = new Map((data.apps ?? []).flatMap((a) => (a.analytics ?? []).map((s) => [sourceId(s), a.id] as const)))
  const claims = new Map<string, Set<string>>()
  for (const [app, list] of proposed) for (const s of list) claims.set(sourceId(s), (claims.get(sourceId(s)) ?? new Set()).add(app))
  for (const [id, apps] of claims) if (apps.size > 1 && !owner.has(id)) notes.push(`${id} is on the pages of ${[...apps].join(' and ')}; add it to the app it belongs to by hand`)
  const changes = []
  for (const app of data.apps ?? []) {
    const add = (proposed.get(app.id) ?? []).filter((s, i, all) => !owner.has(sourceId(s)) && claims.get(sourceId(s))!.size === 1 && all.findIndex((y) => sourceId(y) === sourceId(s)) === i)
    if (add.length) changes.push({ update: 'apps', id: app.id, set: { analytics: [...(app.analytics ?? []), ...add] }, why: add.map((s) => s.provider).join(', ') })
  }
  if (notes.length) console.log(`\n${notes.map((n) => `  ${c.yellow('·')} ${n}`).join('\n')}`)
  if (!changes.length) return console.log(`\n  Nothing new to add to ${display(file)}.`)
  await proposeChanges(file, 'malha analytics detect', changes, opts)
}
