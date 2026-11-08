import { useEffect, useState } from 'react'
import { change, primaryResult, type AnalyticsCache, type Provider, type SourceResult } from '../../core/analytics.ts'
import { TRAFFIC_BASELINE, TRAFFIC_DROP } from '../../core/check.ts'
import { loadAnalytics } from '../source.ts'

// Fetched the first time something needs it, like the scan.
let cached: AnalyticsCache | null | undefined
let pending: Promise<AnalyticsCache | null> | undefined
const loadOnce = () => (pending ??= loadAnalytics().then((a) => (cached = a)))

/** .malha/analytics.json: undefined while loading, null before the first refresh. */
export function useAnalytics() {
  const [data, setData] = useState(cached)
  useEffect(() => {
    if (cached === undefined) loadOnce().then(setData)
  }, [])
  return data
}

export const PROVIDER_LABEL: Record<Provider, string> = { umami: 'Umami', ga4: 'Google Analytics', posthog: 'PostHog', 'search-console': 'Search Console' }

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
const full = new Intl.NumberFormat('en')
export const fmt = (n: number | undefined) => (n === undefined ? '—' : n < 1000 ? String(Math.round(n)) : compact.format(n))
export const fmtFull = (n: number | undefined) => (n === undefined ? '—' : full.format(Math.round(n)))
export const shortDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' })

export interface SiteRow {
  app: string
  main?: SourceResult
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
        main: primaryResult(mine),
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

/** Sum of a top list's values across sites, by key. */
export function mergeTop(lists: { key: string; value: number }[][], limit = 8) {
  const total = new Map<string, number>()
  for (const list of lists) for (const item of list) total.set(item.key, (total.get(item.key) ?? 0) + item.value)
  return [...total].map(([key, value]) => ({ key, value })).sort((a, b) => b.value - a.value).slice(0, limit)
}
