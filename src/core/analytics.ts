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
  totals?: TrafficTotals
  previous?: TrafficTotals
  /** One point per day. */
  series?: { date: string; visitors?: number; pageviews?: number }[]
  top?: { pages?: TopItem[]; referrers?: TopItem[]; countries?: TopItem[]; devices?: TopItem[] }
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
export function primaryResult(results: SourceResult[]) {
  const traffic = results.filter((r) => r.provider !== 'search-console' && r.ok && r.totals)
  return traffic.find((r) => r.primary) ?? traffic[0]
}

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
