// Writes tests/fixtures/analytics.json: made-up traffic for the Acme example over the last 7, 30 and
// 90 days, the same on every run (a seeded generator), for the browser tests and the screenshots.
import { writeFileSync } from 'node:fs'

let seed = 7
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
const DAY = 86_400_000
const iso = (t) => new Date(t).toISOString().slice(0, 10)
const END = Date.parse('2026-10-30T00:00:00Z') // yesterday, for a refresh on Oct 31
const days = (from, n) => Array.from({ length: n }, (_, i) => iso(Date.parse(`${from}T00:00:00Z`) + i * DAY))
const sum = (series, key) => series.reduce((n, p) => n + p[key], 0)
const items = (pairs, scale = 1) => pairs.map(([key, value]) => ({ key, value: Math.round(value * scale) }))

/** A daily series with a weekly rhythm, a trend over the period, and some noise. */
const shape = (from, n, base, trend = 0) =>
  days(from, n).map((date, i) => {
    const weekend = [0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay())
    const visitors = Math.round(base * (1 + trend * (i / Math.max(1, n - 1))) * (weekend ? 0.72 : 1) * (0.88 + rand() * 0.24))
    return { date, visitors, pageviews: Math.round(visitors * (2.4 + rand() * 0.6)) }
  })

function period(n) {
  const range = { from: iso(END - (n - 1) * DAY), to: iso(END) }
  const previous = { from: iso(END - (2 * n - 1) * DAY), to: iso(END - n * DAY) }
  const scale = n / 30
  const traffic = (app, provider, id, base, trend, beforeTrend, top) => {
    const series = shape(range.from, n, base, trend)
    const previousSeries = shape(previous.from, n, base * (1 - trend / 2), beforeTrend)
    const visitors = Math.round(sum(series, 'visitors') * 0.62)
    const before = Math.round(sum(previousSeries, 'visitors') * 0.62)
    return {
      app, provider, id, ok: true,
      totals: { visitors, pageviews: sum(series, 'pageviews'), sessions: Math.round(visitors * 1.3), bounce_rate: 0.41, avg_duration: 74 },
      previous: { visitors: before, pageviews: sum(previousSeries, 'pageviews'), sessions: Math.round(before * 1.3), bounce_rate: 0.44, avg_duration: 69 },
      series, previousSeries,
      top: Object.fromEntries(Object.entries(top).map(([k, v]) => [k, items(v, scale)])),
    }
  }
  const search = (from) => days(from, n).map((date) => ({ date, clicks: Math.round(280 + rand() * 60), impressions: Math.round(7800 + rand() * 900) }))
  const row = ([key, clicks, impressions, ctr, position]) => ({ key, clicks: Math.round(clicks * scale), impressions: Math.round(impressions * scale), ctr, position })
  const results = [
    traffic('shop', 'ga4', '312345678', 1800, 0.18, 0, {
      pages: [['/', 21400], ['/products/kettle', 8200], ['/cart', 6100], ['/products/mugs', 4900], ['/checkout', 3300]],
      referrers: [['google', 14200], ['(direct)', 9100], ['instagram.com', 3800], ['newsletter', 2100], ['bing', 900]],
      countries: [['Germany', 18100], ['Austria', 5200], ['Switzerland', 4400]],
      devices: [['mobile', 21800], ['desktop', 11200], ['tablet', 900]],
      browsers: [['Chrome', 17100], ['Safari', 12300], ['Firefox', 2600], ['Edge', 1800]],
      os: [['Android', 12800], ['iOS', 9900], ['Windows', 7600], ['Macintosh', 3500]],
    }),
    {
      app: 'shop', provider: 'search-console', id: 'sc-domain:acme.example', ok: true,
      search: {
        totals: { clicks: Math.round(9120 * scale), impressions: Math.round(251000 * scale), ctr: 0.0363, position: 8.4 },
        previous: { clicks: Math.round(8400 * scale), impressions: Math.round(236000 * scale), ctr: 0.0356, position: 8.9 },
        series: search(range.from),
        previousSeries: search(previous.from),
        queries: [['acme kettle', 1820, 14100, 0.129, 2.1], ['acme', 1410, 6200, 0.227, 1.2], ['electric kettle 1.7l', 690, 31000, 0.022, 9.8], ['acme mugs', 420, 3900, 0.108, 3.4], ['kettle descaling', 260, 18800, 0.014, 12.6]].map(row),
        pages: [['https://acme.example/', 4100, 41000, 0.1, 3.1], ['https://acme.example/products/kettle', 2900, 88000, 0.033, 7.2]].map(row),
      },
    },
    traffic('admin', 'posthog', '4242', 38, 0, 0, {
      pages: [['/orders', 1900], ['/customers', 700], ['/refunds', 240]],
      referrers: [['(direct)', 1100]],
      countries: [['DE', 940]],
      devices: [['Desktop', 960]],
      browsers: [['Chrome', 700], ['Firefox', 260]],
      os: [['Mac OS X', 610], ['Windows', 350]],
    }),
    traffic('status', 'umami', '7b8f1c2e-5a44-4d1e-9c3a-2f6e8d0b1a55', 140, -0.8, 0, {
      pages: [['/', 3100], ['/incidents/2026-10-14', 900]],
      referrers: [['acme.example', 1700], ['(direct)', 1200]],
      countries: [['DE', 2100], ['AT', 600]],
      devices: [['desktop', 1900], ['mobile', 1100]],
      browsers: [['Chrome', 1800], ['Safari', 900]],
      os: [['Windows', 1300], ['iOS', 800]],
    }),
    { app: 'monitoring', provider: 'umami', id: '0d6f3b1a-0000-4c2b-8e7f-3a9b2c1d4e5f', ok: false, error: 'no login for https://umami.acme.example: set UMAMI_USERNAME and UMAMI_PASSWORD' },
  ]
  // The self-hosted sources link to their server.
  for (const r of results) if (r.provider === 'umami') r.host = 'https://umami.acme.example'
  return { key: `${n}d`, fetched: '2026-10-31T06:00:00.000Z', days: n, range, previous, results }
}

const periods = [7, 30, 90].map(period)
writeFileSync(new URL('./analytics.json', import.meta.url), `${JSON.stringify({ version: 2, periods })}\n`)
console.log(`wrote ${periods.length} periods`)
