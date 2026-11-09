import { useEffect, useState } from 'react'
import { change, isRelative, mainResult, type AnalyticsCache, type AnalyticsFile, type MainResult, type Provider, type SeriesPoint, type SourceResult, type TopItem, type TopList } from '../../core/analytics.ts'
import { TRAFFIC_BASELINE, TRAFFIC_DROP } from '../../core/check.ts'
import { isLive, loadAnalytics } from '../source.ts'

// Fetched the first time something needs it, like the scan.
let cached: AnalyticsFile | null | undefined
let pending: Promise<AnalyticsFile | null> | undefined
const loadOnce = () => (pending ??= loadAnalytics().then((a) => (cached = a)))

/** .malha/analytics.json: undefined while loading, null before the first refresh. */
export function useAnalytics(): AnalyticsFile | null | undefined {
  const [data, setData] = useState(cached)
  useEffect(() => {
    if (cached === undefined) loadOnce().then(setData)
  }, [])
  return data
}

export const PROVIDER_LABEL: Record<Provider, string> = { umami: 'Umami', ga4: 'Google Analytics', posthog: 'PostHog', 'search-console': 'Search Console', cloudflare: 'Cloudflare' }

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
const full = new Intl.NumberFormat('en')
export const fmt = (n: number | undefined) => (n === undefined ? '—' : n < 1000 ? String(Math.round(n)) : compact.format(n))
export const fmtFull = (n: number | undefined) => (n === undefined ? '—' : full.format(Math.round(n)))
export const shortDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' })
export const pct = (x: number | undefined, digits = 1) => (x === undefined ? '—' : `${(x * 100).toFixed(digits)}%`)
export const duration = (s: number | undefined) => (s === undefined ? '—' : s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`)

/** "Last 30 days", or "Sep 1 – Sep 30" for a fixed range. */
export const periodLabel = (p: AnalyticsCache) => (isRelative(p.key) ? `Last ${p.days} days` : `${shortDate(p.range.from)} – ${shortDate(p.range.to)}`)
/** The previous period, in words. */
export const previousLabel = (p: AnalyticsCache) => `${shortDate(p.previous.from)} – ${shortDate(p.previous.to)}`

/** Several sites' daily series added up. */
export function addSeries(lists: (SeriesPoint[] | undefined)[], pick: (p: SeriesPoint) => number | undefined) {
  const days = new Map<string, number>()
  for (const p of lists.flatMap((l) => l ?? [])) days.set(p.date, (days.get(p.date) ?? 0) + (pick(p) ?? 0))
  return [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value }))
}

const token = () => document.querySelector<HTMLMetaElement>('meta[name="malha-token"]')?.content ?? ''
/** `malha dev` with plugins can fetch a range on request; a static build can't. */
export const canFetchRanges = () => isLive() && !!token()

/** Ask `malha dev` to fetch a date range. Resolves to an error message, or undefined once it is written. */
export async function fetchRange(from: string, to: string): Promise<string | undefined> {
  const res = await fetch('api/analytics/range', { method: 'POST', headers: { 'content-type': 'application/json', 'x-malha-token': token() }, body: JSON.stringify({ from, to }) }).catch(() => undefined)
  if (!res) return 'Malha is not running any more.'
  if (!res.ok) return ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`
}

export interface SiteRow {
  app: string
  main?: MainResult
  search?: SourceResult
  failed: SourceResult[]
  providers: Provider[]
}

/** One row per app, busiest first. */
export function siteRows(cache: AnalyticsCache): SiteRow[] {
  const apps = [...new Set(cache.results.map((r) => r.app))]
  return apps
    .map((app) => {
      const mine = cache.results.filter((r) => r.app === app)
      return {
        app,
        main: mainResult(mine),
        search: mine.find((r) => r.provider === 'search-console' && r.ok && r.search),
        failed: mine.filter((r) => !r.ok),
        providers: [...new Set(mine.filter((r) => r.ok).map((r) => r.provider))],
      }
    })
    .sort((a, b) => (b.main?.totals?.visitors ?? -1) - (a.main?.totals?.visitors ?? -1) || (b.search?.search?.totals.clicks ?? 0) - (a.search?.search?.totals.clicks ?? 0))
}

/** The change from the previous period, and whether it is a drop `malha check` would flag. */
export function delta(now: number | undefined, before: number | undefined) {
  const c = change(now, before)
  return { value: c, warn: c !== undefined && (before ?? 0) >= TRAFFIC_BASELINE && -c >= TRAFFIC_DROP.warning }
}

const regions = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(['en'], { type: 'region' }) : undefined

/** Umami's browser ids, as the other providers name the same browsers. */
const BROWSERS: Record<string, string> = {
  'edge-chromium': 'Edge',
  edge: 'Edge',
  ios: 'Mobile Safari',
  'ios-webview': 'Safari (in-app)',
  crios: 'Chrome iOS',
  fxios: 'Firefox iOS',
  samsung: 'Samsung Internet',
  'chromium-webview': 'Android WebView',
  facebook: 'Facebook in-app',
  instagram: 'Instagram in-app',
  miui: 'MIUI Browser',
  yandexbrowser: 'Yandex Browser',
}

/** One spelling per thing across providers: country names for codes ("DE" → "Germany"), browser
 *  names for Umami's ids, and a capital first letter for devices, browsers and systems ("desktop"
 *  and "Desktop" are one). */
export function tidy(list: TopList, items: TopItem[]): TopItem[] {
  const name = (k: string) => {
    if (list === 'browsers' && BROWSERS[k]) return BROWSERS[k]
    if (list === 'countries' && /^[A-Z]{2}$/.test(k)) {
      try {
        return regions?.of(k) ?? k
      } catch {
        return k
      }
    }
    return list === 'devices' || list === 'browsers' || list === 'os' ? k.charAt(0).toUpperCase() + k.slice(1) : k
  }
  return mergeTop([items.map((i) => ({ key: name(i.key), value: i.value }))], items.length)
}

/** Sum of a top list's values across sites, by key. */
export function mergeTop(lists: { key: string; value: number }[][], limit = 8) {
  const total = new Map<string, number>()
  for (const list of lists) for (const item of list) total.set(item.key, (total.get(item.key) ?? 0) + item.value)
  return [...total].map(([key, value]) => ({ key, value })).sort((a, b) => b.value - a.value).slice(0, limit)
}
