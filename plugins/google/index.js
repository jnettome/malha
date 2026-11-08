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

async function ga4(ctx, token, source, req) {
  const id = propertyId(source.id)
  const now = { startDate: req.range.from, endDate: req.range.to }
  const topReport = (dimension, metricName) => ({
    dateRanges: [now],
    dimensions: [{ name: dimension }],
    metrics: [{ name: metricName }],
    orderBys: [{ metric: { metricName }, desc: true }],
    limit: 10,
  })
  const batch = await call(ctx, token, 'POST', `${DATA}/properties/${id}:batchRunReports`, {
    requests: [
      {
        dateRanges: [{ ...now, name: 'now' }, { startDate: req.previous.from, endDate: req.previous.to, name: 'before' }],
        metrics: ['activeUsers', 'screenPageViews', 'sessions', 'bounceRate', 'averageSessionDuration'].map((name) => ({ name })),
      },
      { dateRanges: [now], dimensions: [{ name: 'date' }], metrics: [{ name: 'activeUsers' }, { name: 'screenPageViews' }], orderBys: [{ dimension: { dimensionName: 'date' } }], limit: 400 },
      topReport('pagePath', 'screenPageViews'),
      topReport('sessionSource', 'sessions'),
      topReport('country', 'activeUsers'),
    ],
  })
  const [totalsReport, seriesReport, pages, referrers, countries] = batch.reports ?? []
  const devices = await call(ctx, token, 'POST', `${DATA}/properties/${id}:runReport`, topReport('deviceCategory', 'activeUsers'))
  const range = (name) => (totalsReport?.rows ?? []).find((r) => r.dimensionValues?.some((d) => d.value === name))
  const totals = (row) => (row ? { visitors: metric(row, 0), pageviews: metric(row, 1), sessions: metric(row, 2), bounce_rate: metric(row, 3), avg_duration: metric(row, 4) } : { visitors: 0, pageviews: 0, sessions: 0 })
  const byDay = new Map((seriesReport?.rows ?? []).map((r) => [isoDate(r.dimensionValues[0].value), { visitors: metric(r, 0), pageviews: metric(r, 1) }]))
  const days = []
  for (let t = Date.parse(`${req.range.from}T00:00:00Z`); t <= Date.parse(`${req.range.to}T00:00:00Z`); t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10)
    days.push({ date, ...(byDay.get(date) ?? { visitors: 0, pageviews: 0 }) })
  }
  const top = (report) => (report?.rows ?? []).map((r) => ({ key: r.dimensionValues?.[0]?.value || '(not set)', value: metric(r, 0) }))
  return { totals: totals(range('now')), previous: totals(range('before')), series: days, top: { pages: top(pages), referrers: top(referrers), countries: top(countries), devices: top(devices) } }
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
  const [now, before, series, queries, pages] = await Promise.all([
    q(req.range, [], 1),
    q(req.previous, [], 1),
    q(req.range, ['date'], 400),
    q(req.range, ['query'], 10),
    q(req.range, ['page'], 10),
  ])
  return { search: { totals: sum(now), previous: sum(before), series: (series.rows ?? []).map((r) => ({ date: r.keys[0], clicks: r.clicks, impressions: r.impressions })), queries: rows(queries), pages: rows(pages) } }
}

export default {
  async analytics(ctx, req) {
    const token = await accessToken(ctx, await serviceAccount(ctx))
    const results = []
    for (const source of req.sources) {
      const base = { app: source.app, provider: source.provider, id: String(source.id) }
      try {
        const data = source.provider === 'ga4' ? await ga4(ctx, token, source, req) : await searchConsole(ctx, token, source, req)
        results.push({ ...base, ok: true, ...data })
      } catch (e) {
        results.push({ ...base, ok: false, error: e.message })
      }
    }
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
