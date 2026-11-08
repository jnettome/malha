// Traffic from analytics providers (Umami, Google Analytics, PostHog, Search Console), in one shape.
// Plugins fetch it; `malha analytics refresh` writes .malha/analytics.json; the Traffic tab and
// `malha check` read it.

export type Provider = 'umami' | 'ga4' | 'posthog' | 'search-console'
export const PROVIDERS: Provider[] = ['umami', 'ga4', 'posthog', 'search-console']

/** One analytics source of an app, as topology.yaml lists it under `analytics`. */
export interface AnalyticsSource {
  provider: Provider
  /** Umami website id, GA4 property id, PostHog project id, or Search Console property ("sc-domain:acme.example"). */
  id: string | number
  /** The provider's server, for self-hosted Umami and PostHog. */
  host?: string
  /** The source the Traffic tab counts for the app, when it has several (default: the first that is not Search Console). */
  primary?: boolean
}

export interface TrafficTotals {
  /** Unique visitors (Umami visitors, GA4 active users, PostHog distinct persons). */
  visitors?: number
  pageviews?: number
  sessions?: number
  /** 0..1 */
  bounce_rate?: number
  /** Seconds per session. */
  avg_duration?: number
}

export interface SearchTotals {
  clicks: number
  impressions: number
  /** 0..1 */
  ctr: number
  /** Average position in results; lower is better. */
  position: number
}

export interface TopItem {
  key: string
  value: number
}

export interface SearchQuery extends SearchTotals {
  key: string
}

/** What one source returned for one app. */
export interface SourceResult {
  app: string
  provider: Provider
  id: string
  host?: string
  /** Copied from the source: this is the app's main traffic source. */
  primary?: boolean
  ok: boolean
  error?: string
  /** Something worth a look in an answer that is otherwise fine, such as a project with no pageviews. */
  note?: string
  totals?: TrafficTotals
  previous?: TrafficTotals
  /** One point per day. */
  series?: SeriesPoint[]
  /** The same for the previous period, day by day, to draw beside it. */
  previousSeries?: SeriesPoint[]
  top?: Top
  /** Pageviews per hostname across the whole project, before it is narrowed to the app's hostnames:
   *  how Malha spots hostnames the topology doesn't list (PostHog). */
  allHosts?: TopItem[]
  /** Search Console sources fill this instead of the traffic fields. */
  search?: {
    totals: SearchTotals
    previous?: SearchTotals
    series: SearchPoint[]
    previousSeries?: SearchPoint[]
    queries: SearchQuery[]
    pages: SearchQuery[]
  }
}

export interface SeriesPoint {
  date: string
  visitors?: number
  pageviews?: number
}

export interface SearchPoint {
  date: string
  clicks: number
  impressions: number
}

export const TOP_LISTS = ['pages', 'referrers', 'countries', 'devices', 'browsers', 'os'] as const
export type TopList = (typeof TOP_LISTS)[number]
export type Top = Partial<Record<TopList, TopItem[]>>

export interface DateRange {
  from: string
  to: string
}

/** One period of traffic: every source's numbers for one date range, and the range before it. */
export interface AnalyticsCache {
  /** "30d" for the last 30 days (fetched again on every refresh), "2026-09-01..2026-09-30" for a fixed range. */
  key: string
  fetched: string
  days: number
  range: DateRange
  previous: DateRange
  results: SourceResult[]
}

/** .malha/analytics.json */
export interface AnalyticsFile {
  version: 2
  periods: AnalyticsCache[]
}

/** The periods every refresh fetches, in days. */
export const PRESETS = [7, 30, 90]
/** The period checks and the terminal summary use. */
export const DEFAULT_PERIOD = '30d'
/** Fixed ranges kept in the file besides the relative ones; the oldest fetched go first. */
export const MAX_CUSTOM = 8

export const isRelative = (key: string) => /^\d+d$/.test(key)
export const rangeKey = (r: DateRange) => `${r.from}..${r.to}`

/** The file as written by any version: 0.6 wrote one period at the top level. */
export function normalizeAnalytics(raw: unknown): AnalyticsFile | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Partial<AnalyticsFile> & Partial<AnalyticsCache>
  if (Array.isArray(o.periods)) return { version: 2, periods: o.periods.filter((p) => p && Array.isArray(p.results)) }
  if (Array.isArray(o.results) && o.range && o.previous && o.fetched) return { version: 2, periods: [{ ...(o as AnalyticsCache), key: o.key ?? `${o.days}d` }] }
  return null
}

/** A period by key; else the default one, else the first relative one, else the first. */
export function pickPeriod(file: AnalyticsFile | null | undefined, key?: string): AnalyticsCache | undefined {
  const p = file?.periods ?? []
  return (key && p.find((x) => x.key === key)) || p.find((x) => x.key === DEFAULT_PERIOD) || p.find((x) => isRelative(x.key)) || p[0]
}

const DAY = 86_400_000
const iso = (t: number) => new Date(t).toISOString().slice(0, 10)
const parseDay = (s: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s) && iso(Date.parse(`${s}T00:00:00Z`)) === s ? Date.parse(`${s}T00:00:00Z`) : NaN)

/** A fixed range and the same number of days just before it, or why it can't be fetched. */
export function customRange(from: string, to: string, today = new Date()): { range: DateRange; previous: DateRange; days: number } | { error: string } {
  const f = parseDay(from)
  const t = parseDay(to)
  if (Number.isNaN(f) || Number.isNaN(t)) return { error: 'dates are YYYY-MM-DD' }
  const yesterday = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - DAY
  if (f > t) return { error: 'the range starts after it ends' }
  if (t > yesterday) return { error: `the range must end by yesterday (${iso(yesterday)}): today is not over yet` }
  if (f < Date.parse('2015-01-01T00:00:00Z')) return { error: 'the range starts before 2015' }
  const days = Math.round((t - f) / DAY) + 1
  if (days > 366) return { error: 'a range is at most 366 days' }
  return { range: { from, to }, previous: { from: iso(f - days * DAY), to: iso(f - DAY) }, days }
}

/** Where a source's own dashboard is, built only from its validated id and server, never from
 *  anything a plugin returned. Ranges go in the link where the provider reads them. */
export function panelUrl(s: { provider: Provider; id: string | number; host?: string }, range?: DateRange): string | undefined {
  const id = String(s.id)
  const host = s.host && /^https?:\/\/[^/\s?#]+$/.test(s.host) ? s.host.replace(/\/+$/, '') : undefined
  const compact = (d: string) => d.replaceAll('-', '')
  switch (s.provider) {
    case 'ga4':
      return /^\d+$/.test(id) ? `https://analytics.google.com/analytics/web/#/p${id}/reports/intelligenthome` : undefined
    case 'search-console': {
      if (!/^(sc-domain:[a-z0-9.-]+|https?:\/\/[^\s]+)$/i.test(id)) return undefined
      const dates = range ? `&start_date=${compact(range.from)}&end_date=${compact(range.to)}` : ''
      return `https://search.google.com/search-console/performance/search-analytics?resource_id=${encodeURIComponent(id)}${dates}`
    }
    case 'posthog': {
      if (!/^\d+$/.test(id)) return undefined
      const dates = range ? `?date_from=${range.from}&date_to=${range.to}` : ''
      return `${host ?? 'https://us.posthog.com'}/project/${id}/web${dates}`
    }
    case 'umami': {
      if (!/^[0-9a-f-]{36}$/i.test(id) || !host) return undefined
      return `${host === 'https://api.umami.is' ? 'https://cloud.umami.is' : host}/websites/${id}`
    }
  }
}

/** The request a plugin's analytics() gets: its sources, with each app's hostnames for filtering. */
export interface AnalyticsRequest {
  range: DateRange
  previous: DateRange
  timezone: string
  sources: (AnalyticsSource & { app: string; hostnames: string[] })[]
}

/** What `malha analytics detect` found on an app's pages, handed to plugins to resolve into sources. */
export interface Trackers {
  app: string
  hostnames: string[]
  umami: { website: string; script: string }[]
  ga4: string[]
  gtm: string[]
  posthog: { key: string; host?: string }[]
}

export const sourceId = (s: { provider: string; id: string | number }) => `${s.provider}:${s.id}`

/** An app's traffic, from its main provider: the provider of its `primary` source, else of its first
 *  traffic source. Every source of that provider is added up, since each usually measures another of
 *  the app's sites (a whitelabel with its own project); other providers are left out, since they
 *  measure the same visits again. `parts` lists the sources when there are several. */
export function mainResult(results: SourceResult[]): MainResult | undefined {
  const traffic = results.filter((r) => r.provider !== 'search-console' && r.ok && r.totals)
  const first = traffic.find((r) => r.primary) ?? traffic[0]
  if (!first) return undefined
  const parts = traffic.filter((r) => r.provider === first.provider)
  if (parts.length === 1) return first
  const sum = (list: (TrafficTotals | undefined)[]): TrafficTotals | undefined => {
    const t = list.filter((x): x is TrafficTotals => !!x)
    if (!t.length) return undefined
    const add = (k: 'visitors' | 'pageviews' | 'sessions') => (t.some((x) => x[k] !== undefined) ? t.reduce((n, x) => n + (x[k] ?? 0), 0) : undefined)
    // Rates are weighted by sessions (or visitors), and only when every source has them.
    const weighted = (k: 'bounce_rate' | 'avg_duration') => {
      const w = (x: TrafficTotals) => x.sessions ?? x.visitors ?? 0
      const total = t.reduce((n, x) => n + w(x), 0)
      return total && t.every((x) => x[k] !== undefined) ? t.reduce((n, x) => n + x[k]! * w(x), 0) / total : undefined
    }
    return { visitors: add('visitors'), pageviews: add('pageviews'), sessions: add('sessions'), bounce_rate: weighted('bounce_rate'), avg_duration: weighted('avg_duration') }
  }
  const addSeries = (lists: (SeriesPoint[] | undefined)[]) => {
    const days = new Map<string, SeriesPoint>()
    for (const p of lists.flatMap((l) => l ?? [])) {
      const d = days.get(p.date) ?? { date: p.date }
      if (p.visitors !== undefined) d.visitors = (d.visitors ?? 0) + p.visitors
      if (p.pageviews !== undefined) d.pageviews = (d.pageviews ?? 0) + p.pageviews
      days.set(p.date, d)
    }
    return [...days.values()].sort((a, b) => a.date.localeCompare(b.date))
  }
  const merge = (lists: (TopItem[] | undefined)[]) => {
    const total = new Map<string, number>()
    for (const item of lists.flatMap((l) => l ?? [])) total.set(item.key, (total.get(item.key) ?? 0) + item.value)
    return [...total].map(([key, value]) => ({ key, value })).sort((a, b) => b.value - a.value).slice(0, 25)
  }
  const top = Object.fromEntries(TOP_LISTS.map((k) => [k, merge(parts.map((r) => r.top?.[k]))])) as Top
  return {
    app: first.app,
    provider: first.provider,
    id: parts.map((r) => r.id).join(' + '),
    ok: true,
    primary: first.primary,
    totals: sum(parts.map((r) => r.totals)),
    previous: parts.every((r) => r.previous) ? sum(parts.map((r) => r.previous)) : undefined,
    series: addSeries(parts.map((r) => r.series)),
    previousSeries: parts.every((r) => r.previousSeries) ? addSeries(parts.map((r) => r.previousSeries)) : undefined,
    top,
    parts,
  }
}

export type MainResult = SourceResult & { parts?: SourceResult[] }

/** Relative change from `before` to `now`; undefined when there is no baseline. */
export function change(now: number | undefined, before: number | undefined) {
  if (now === undefined || before === undefined || before === 0) return undefined
  return (now - before) / before
}

/** `days` whole days ending yesterday, and the same length just before. */
export function ranges(days: number, today = new Date()): { range: DateRange; previous: DateRange } {
  const day = (offset: number) => {
    const d = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - offset * 86_400_000)
    return d.toISOString().slice(0, 10)
  }
  return { range: { from: day(days), to: day(1) }, previous: { from: day(days * 2), to: day(days + 1) } }
}

/** Below this, a hostname's pageviews are noise (a preview deploy, someone's test). */
export const UNLISTED_MIN = 20

const listedBy = (host: string, domains: string[]) => domains.some((d) => d === host || (d.startsWith('*.') && host.endsWith(d.slice(1))))

/** Hostnames a source counted pageviews on that no app in the topology lists: traffic that is
 *  dropped from every app's numbers until the hostname is added to the right app's domains. */
export function unlistedHosts(results: SourceResult[], apps: { id: string; domains?: string[] }[]) {
  const all = apps.flatMap((a) => a.domains ?? [])
  return results.flatMap((r) =>
    (r.allHosts ?? [])
      .filter((h) => h.value >= UNLISTED_MIN && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(h.key) && !/^[\d.]+$/.test(h.key) && !listedBy(h.key.toLowerCase(), all))
      .map((h) => ({ app: r.app, provider: r.provider, id: r.id, host: h.key.toLowerCase(), pageviews: h.value })),
  )
}
