// Writes tests/fixtures/analytics.json: 30 days of made-up traffic for the Acme example, the same on
// every run (a seeded generator), for the browser tests and the screenshots.
import { writeFileSync } from 'node:fs'

let seed = 7
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
const days = (from, n) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10))
const range = { from: '2026-10-01', to: '2026-10-30' }
const previous = { from: '2026-09-01', to: '2026-09-30' }
const shape = (base, trend = 0) => days(range.from, 30).map((date, i) => {
  const weekend = [0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay())
  const visitors = Math.round(base * (1 + trend * (i / 29)) * (weekend ? 0.72 : 1) * (0.88 + rand() * 0.24))
  return { date, visitors, pageviews: Math.round(visitors * (2.4 + rand() * 0.6)) }
})
const sum = (series, key) => series.reduce((n, p) => n + p[key], 0)
const traffic = (app, provider, id, base, trend, before, top) => {
  const series = shape(base, trend)
  const visitors = Math.round(sum(series, 'visitors') * 0.62)
  return {
    app, provider, id, ok: true,
    totals: { visitors, pageviews: sum(series, 'pageviews'), sessions: Math.round(visitors * 1.3), bounce_rate: 0.41, avg_duration: 74 },
    previous: { visitors: before, pageviews: Math.round(before * 2.7), sessions: Math.round(before * 1.3) },
    series, top,
  }
}
const items = (pairs) => pairs.map(([key, value]) => ({ key, value }))
const results = [
  traffic('shop', 'ga4', '312345678', 1800, 0.18, 30100, {
    pages: items([['/', 21400], ['/products/kettle', 8200], ['/cart', 6100], ['/products/mugs', 4900], ['/checkout', 3300]]),
    referrers: items([['google', 14200], ['(direct)', 9100], ['instagram.com', 3800], ['newsletter', 2100], ['bing', 900]]),
    countries: items([['Germany', 18100], ['Austria', 5200], ['Switzerland', 4400]]),
    devices: items([['mobile', 21800], ['desktop', 11200], ['tablet', 900]]),
  }),
  {
    app: 'shop', provider: 'search-console', id: 'sc-domain:acme.example', ok: true,
    search: {
      totals: { clicks: 9120, impressions: 251000, ctr: 0.0363, position: 8.4 },
      previous: { clicks: 8400, impressions: 236000, ctr: 0.0356, position: 8.9 },
      series: days(range.from, 30).map((date) => ({ date, clicks: Math.round(280 + rand() * 60), impressions: Math.round(7800 + rand() * 900) })),
      queries: [['acme kettle', 1820, 14100, 0.129, 2.1], ['acme', 1410, 6200, 0.227, 1.2], ['electric kettle 1.7l', 690, 31000, 0.022, 9.8], ['acme mugs', 420, 3900, 0.108, 3.4], ['kettle descaling', 260, 18800, 0.014, 12.6]].map(([key, clicks, impressions, ctr, position]) => ({ key, clicks, impressions, ctr, position })),
      pages: [['https://acme.example/', 4100, 41000, 0.1, 3.1], ['https://acme.example/products/kettle', 2900, 88000, 0.033, 7.2]].map(([key, clicks, impressions, ctr, position]) => ({ key, clicks, impressions, ctr, position })),
    },
  },
  traffic('admin', 'posthog', '4242', 38, 0, 900, {
    pages: items([['/orders', 1900], ['/customers', 700], ['/refunds', 240]]),
    referrers: items([['(direct)', 1100]]),
    countries: items([['DE', 940]]),
    devices: items([['Desktop', 960]]),
  }),
  traffic('status', 'umami', '7b8f1c2e-5a44-4d1e-9c3a-2f6e8d0b1a55', 140, -0.55, 4300, {
    pages: items([['/', 3100], ['/incidents/2026-10-14', 900]]),
    referrers: items([['acme.example', 1700], ['(direct)', 1200]]),
    countries: items([['DE', 2100], ['AT', 600]]),
    devices: items([['desktop', 1900], ['mobile', 1100]]),
  }),
  { app: 'monitoring', provider: 'umami', id: '0d6f3b1a-0000-4c2b-8e7f-3a9b2c1d4e5f', ok: false, error: 'no login for https://umami.acme.example: set UMAMI_USERNAME and UMAMI_PASSWORD' },
]
writeFileSync(new URL('./analytics.json', import.meta.url), `${JSON.stringify({ fetched: '2026-10-31T06:00:00.000Z', days: 30, range, previous, results }, null, 2)}\n`)
console.log(`wrote ${results.length} results`)
