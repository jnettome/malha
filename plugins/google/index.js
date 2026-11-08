// Google Analytics 4 and Search Console, read with a service account: its JSON key in
// GOOGLE_SERVICE_ACCOUNT or ~/.config/malha/google-service-account.json. Add the account's email as
// a Viewer on each GA4 property, and as a (restricted) user on each Search Console property.
// The token is signed here, with WebCrypto: no browser sign-in, and it works in CI.

const SCOPES = 'https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/webmasters.readonly'
const DATA = 'https://analyticsdata.googleapis.com/v1beta'
const ADMIN = 'https://analyticsadmin.googleapis.com/v1beta'
const SC = 'https://www.googleapis.com/webmasters/v3'

const b64url = (data) => Buffer.from(data).toString('base64url')

async function serviceAccount(ctx) {
  let raw = await ctx.env('GOOGLE_SERVICE_ACCOUNT')
  if (!raw) {
    try {
      raw = await ctx.readFile('~/.config/malha/google-service-account.json')
    } catch (e) {
      if (e.code === 'MALHA_NOT_FOUND') throw new Error('no service account: put its JSON key in ~/.config/malha/google-service-account.json, or in GOOGLE_SERVICE_ACCOUNT')
      throw e
    }
  }
  const key = JSON.parse(raw)
  if (!key.client_email || !key.private_key) throw new Error('the service account JSON has no client_email or private_key')
  return key
}

/** An OAuth access token for the service account, from a JWT signed with its private key. */
export async function accessToken(ctx, key) {
  const now = Math.floor(Date.now() / 1000)
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = b64url(JSON.stringify({ iss: key.client_email, scope: SCOPES, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }))
  const der = Buffer.from(key.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64')
  const signer = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signer, new TextEncoder().encode(`${head}.${claims}`))
  const res = await ctx.fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${head}.${claims}.${b64url(signature)}`,
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body.access_token) throw new Error(`Google refused the service account: ${body.error_description ?? body.error ?? res.status}`)
  return body.access_token
}

async function call(ctx, token, method, url, body) {
  const res = await ctx.fetch(url, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error?.message ?? `Google answered ${res.status}`)
  return json
}

// ---- GA4 ---------------------------------------------------------------------------------------

const propertyId = (id) => String(id).replace(/^properties\//, '')
const metric = (row, i) => Number(row?.metricValues?.[i]?.value ?? 0)
const isoDate = (yyyymmdd) => `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`

/** Every day of a range, filled from a map of date → values, zeros where there is none. */
function everyDay(range, byDay, zero) {
  const out = []
  for (let t = Date.parse(`${range.from}T00:00:00Z`); t <= Date.parse(`${range.to}T00:00:00Z`); t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10)
    out.push({ date, ...(byDay.get(date) ?? zero) })
  }
  return out
}

/** Runs `fn` over `items`, `n` at a time. */
async function pool(items, n, fn) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }))
  return out
}

async function ga4(ctx, token, source, req) {
  const id = propertyId(source.id)
  const now = { startDate: req.range.from, endDate: req.range.to }
  const seriesReport = (range) => ({ dateRanges: [range], dimensions: [{ name: 'date' }], metrics: [{ name: 'activeUsers' }, { name: 'screenPageViews' }], orderBys: [{ dimension: { dimensionName: 'date' } }], limit: 400 })
  const topReport = (dimension, metricName) => ({
    dateRanges: [now],
    dimensions: [{ name: dimension }],
    metrics: [{ name: metricName }],
    orderBys: [{ metric: { metricName }, desc: true }],
    limit: 10,
  })
  // A batch takes at most five reports.
  const batch = (requests) => call(ctx, token, 'POST', `${DATA}/properties/${id}:batchRunReports`, { requests }).then((b) => b.reports ?? [])
  const [[totalsReport, nowSeries, pages, referrers, countries], [beforeSeries, devices, browsers, os]] = await Promise.all([
    batch([
      {
        dateRanges: [{ ...now, name: 'now' }, { startDate: req.previous.from, endDate: req.previous.to, name: 'before' }],
        metrics: ['activeUsers', 'screenPageViews', 'sessions', 'bounceRate', 'averageSessionDuration'].map((name) => ({ name })),
      },
      seriesReport(now),
      topReport('pagePath', 'screenPageViews'),
      topReport('sessionSource', 'sessions'),
      topReport('country', 'activeUsers'),
    ]),
    batch([seriesReport({ startDate: req.previous.from, endDate: req.previous.to }), topReport('deviceCategory', 'activeUsers'), topReport('browser', 'activeUsers'), topReport('operatingSystem', 'activeUsers')]),
  ])
  const range = (name) => (totalsReport?.rows ?? []).find((r) => r.dimensionValues?.some((d) => d.value === name))
  const totals = (row) => (row ? { visitors: metric(row, 0), pageviews: metric(row, 1), sessions: metric(row, 2), bounce_rate: metric(row, 3), avg_duration: metric(row, 4) } : { visitors: 0, pageviews: 0, sessions: 0 })
  const byDay = (report) => new Map((report?.rows ?? []).map((r) => [isoDate(r.dimensionValues[0].value), { visitors: metric(r, 0), pageviews: metric(r, 1) }]))
  const zero = { visitors: 0, pageviews: 0 }
  const top = (report) => (report?.rows ?? []).map((r) => ({ key: r.dimensionValues?.[0]?.value || '(not set)', value: metric(r, 0) }))
  return {
    totals: totals(range('now')),
    previous: totals(range('before')),
    series: everyDay(req.range, byDay(nowSeries), zero),
    previousSeries: everyDay(req.previous, byDay(beforeSeries), zero),
    top: { pages: top(pages), referrers: top(referrers), countries: top(countries), devices: top(devices), browsers: top(browsers), os: top(os) },
  }
}

// ---- Search Console ----------------------------------------------------------------------------

async function searchConsole(ctx, token, source, req) {
  const url = `${SC}/sites/${encodeURIComponent(String(source.id))}/searchAnalytics/query`
  const q = (range, dimensions, rowLimit) => call(ctx, token, 'POST', url, { startDate: range.from, endDate: range.to, dimensions, rowLimit, dataState: 'all' })
  const sum = (body) => {
    const r = body.rows?.[0]
    return { clicks: r?.clicks ?? 0, impressions: r?.impressions ?? 0, ctr: r?.ctr ?? 0, position: r?.position ?? 0 }
  }
  const rows = (body) => (body.rows ?? []).map((r) => ({ key: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position }))
  const [now, before, series, previousSeries, queries, pages] = await Promise.all([
    q(req.range, [], 1),
    q(req.previous, [], 1),
    q(req.range, ['date'], 400),
    q(req.previous, ['date'], 400),
    q(req.range, ['query'], 25),
    q(req.range, ['page'], 25),
  ])
  const zero = { clicks: 0, impressions: 0 }
  const byDay = (body) => new Map((body.rows ?? []).map((r) => [r.keys[0], { clicks: r.clicks, impressions: r.impressions }]))
  return {
    search: {
      totals: sum(now),
      previous: sum(before),
      series: everyDay(req.range, byDay(series), zero),
      previousSeries: everyDay(req.previous, byDay(previousSeries), zero),
      queries: rows(queries),
      pages: rows(pages),
    },
  }
}

export default {
  async analytics(ctx, req) {
    const token = await accessToken(ctx, await serviceAccount(ctx))
    // Three properties at a time: well inside Google's limits, and a third of the wait.
    const results = await pool(req.sources, 3, async (source) => {
      const base = { app: source.app, provider: source.provider, id: String(source.id) }
      try {
        return { ...base, ok: true, ...(source.provider === 'ga4' ? await ga4(ctx, token, source, req) : await searchConsole(ctx, token, source, req)) }
      } catch (e) {
        return { ...base, ok: false, error: e.message }
      }
    })
    return { results }
  },

  async link(ctx, { trackers }) {
    const key = await serviceAccount(ctx)
    const token = await accessToken(ctx, key)
    const sources = []
    const notes = []

    // GA4: measurement id on the page → the property whose web stream has it.
    const wanted = new Set(trackers.flatMap((t) => t.ga4))
    if (wanted.size) {
      const byMeasurement = new Map()
      const summaries = await call(ctx, token, 'GET', `${ADMIN}/accountSummaries?pageSize=200`)
      for (const account of summaries.accountSummaries ?? [])
        for (const p of account.propertySummaries ?? []) {
          const streams = await call(ctx, token, 'GET', `${ADMIN}/${p.property}/dataStreams?pageSize=200`)
          for (const s of streams.dataStreams ?? []) if (s.webStreamData?.measurementId) byMeasurement.set(s.webStreamData.measurementId, propertyId(p.property))
        }
      for (const t of trackers)
        for (const g of t.ga4) {
          if (byMeasurement.has(g)) sources.push({ app: t.app, source: { provider: 'ga4', id: byMeasurement.get(g) } })
          else notes.push(`${t.app}: ${key.client_email} cannot see the GA4 property for ${g}; add it as a Viewer`)
        }
    }

    // Search Console: each property goes to the app that owns its domain (or the URL's host).
    const sites = (await call(ctx, token, 'GET', `${SC}/sites`)).siteEntry ?? []
    for (const site of sites) {
      if (site.permissionLevel === 'siteUnverifiedUser') continue
      const url = site.siteUrl
      const domain = url.startsWith('sc-domain:') ? url.slice(10) : undefined
      const host = domain ? undefined : new URL(url).hostname
      const owns = (t) => (domain ? t.hostnames.some((h) => h === domain || h.endsWith(`.${domain}`)) : t.hostnames.includes(host))
      const candidates = trackers.filter(owns)
      const apex = domain ? candidates.filter((t) => t.hostnames.includes(domain) || t.hostnames.includes(`www.${domain}`)) : candidates
      const pick = apex.length === 1 ? apex[0] : candidates.length === 1 ? candidates[0] : undefined
      if (pick) sources.push({ app: pick.app, source: { provider: 'search-console', id: url } })
      else if (candidates.length) notes.push(`Search Console ${url}: serves ${candidates.map((t) => t.app).join(', ')}; add it to the right app by hand`)
    }
    return { sources, notes }
  },
}
