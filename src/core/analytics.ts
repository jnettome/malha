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
  series?: { date: string; visitors?: number; pageviews?: number }[]
  top?: { pages?: TopItem[]; referrers?: TopItem[]; countries?: TopItem[]; devices?: TopItem[] }
  /** Pageviews per hostname across the whole project, before it is narrowed to the app's hostnames:
   *  how Malha spots hostnames the topology doesn't list (PostHog). */
  allHosts?: TopItem[]
  /** Search Console sources fill this instead of the traffic fields. */
  search?: {
    totals: SearchTotals
    previous?: SearchTotals
    series: { date: string; clicks: number; impressions: number }[]
    queries: SearchQuery[]
    pages: SearchQuery[]
  }
}

export interface DateRange {
  from: string
  to: string
}

/** .malha/analytics.json */
export interface AnalyticsCache {
  fetched: string
  days: number
  range: DateRange
  previous: DateRange
  results: SourceResult[]
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

/** The traffic source the overview counts for an app: the one marked primary, else the first. */
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
  const days = new Map<string, { date: string; visitors?: number; pageviews?: number }>()
  for (const p of parts.flatMap((r) => r.series ?? [])) {
    const d = days.get(p.date) ?? { date: p.date }
    if (p.visitors !== undefined) d.visitors = (d.visitors ?? 0) + p.visitors
    if (p.pageviews !== undefined) d.pageviews = (d.pageviews ?? 0) + p.pageviews
    days.set(p.date, d)
  }
  const merge = (lists: (TopItem[] | undefined)[]) => {
    const total = new Map<string, number>()
    for (const item of lists.flatMap((l) => l ?? [])) total.set(item.key, (total.get(item.key) ?? 0) + item.value)
    return [...total].map(([key, value]) => ({ key, value })).sort((a, b) => b.value - a.value).slice(0, 25)
  }
  const top = (k: 'pages' | 'referrers' | 'countries' | 'devices') => merge(parts.map((r) => r.top?.[k]))
  return {
    app: first.app,
    provider: first.provider,
    id: parts.map((r) => r.id).join(' + '),
    ok: true,
    primary: first.primary,
    totals: sum(parts.map((r) => r.totals)),
    previous: parts.every((r) => r.previous) ? sum(parts.map((r) => r.previous)) : undefined,
    series: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    top: { pages: top('pages'), referrers: top('referrers'), countries: top('countries'), devices: top('devices') },
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
