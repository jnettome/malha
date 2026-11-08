// Umami, cloud or self-hosted. options.hosts lists the servers ("https://api.umami.is" for Umami
// Cloud). Credentials: UMAMI_API_KEY (Cloud), or UMAMI_USERNAME and UMAMI_PASSWORD (your server), or
// ~/.config/malha/umami.json with one entry per host: { "https://u.example.com": { "username": …,
// "password": … }, "https://api.umami.is": { "apiKey": … } }.

const CLOUD = 'https://api.umami.is'
const CLOUD_SCRIPT = 'https://cloud.umami.is'
const api = (host) => (host === CLOUD ? `${host}/v1` : `${host}/api`)
const hostsOf = (ctx) => [ctx.options.hosts ?? []].flat().map((h) => String(h).replace(/\/+$/, ''))

async function fileCredentials(ctx) {
  try {
    return JSON.parse(await ctx.readFile('~/.config/malha/umami.json'))
  } catch (e) {
    if (e.code === 'MALHA_NOT_FOUND') return {}
    throw e
  }
}

/** Request headers for a host: an API key, or a token from logging in. Cached for the run. */
function auth(ctx) {
  const cache = new Map()
  let file
  return async (host) => {
    if (cache.has(host)) return cache.get(host)
    file ??= await fileCredentials(ctx)
    const creds = file[host] ?? {}
    const apiKey = creds.apiKey ?? (await ctx.env('UMAMI_API_KEY'))
    let headers
    if (host === CLOUD || (apiKey && !creds.username)) {
      if (!apiKey) throw new Error(`no API key for ${host}: set UMAMI_API_KEY, or "apiKey" for it in ~/.config/malha/umami.json`)
      headers = { 'x-umami-api-key': apiKey, accept: 'application/json' }
    } else {
      const username = creds.username ?? (await ctx.env('UMAMI_USERNAME'))
      const password = creds.password ?? (await ctx.env('UMAMI_PASSWORD'))
      if (!username || !password) throw new Error(`no login for ${host}: set UMAMI_USERNAME and UMAMI_PASSWORD, or put them for it in ~/.config/malha/umami.json`)
      const res = await ctx.fetch(`${api(host)}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) })
      if (!res.ok) throw new Error(`${host} refused the login (${res.status})`)
      headers = { authorization: `Bearer ${(await res.json()).token}`, accept: 'application/json' }
    }
    cache.set(host, headers)
    return headers
  }
}

async function get(ctx, headers, url) {
  const res = await ctx.fetch(url, { headers })
  if (!res.ok) {
    const err = new Error(`${res.status} from ${url.replace(/\?.*/, '')}`)
    err.status = res.status
    throw err
  }
  return res.json()
}

// Umami 2 returns { value, prev } for each stat; Umami 3 plain numbers.
const val = (x) => (typeof x === 'number' ? x : typeof x?.value === 'number' ? x.value : undefined)
const ms = (date, end) => Date.parse(`${date}T${end ? '23:59:59.999' : '00:00:00'}Z`)

function totals(s) {
  const visits = val(s.visits)
  return {
    visitors: val(s.visitors),
    pageviews: val(s.pageviews),
    sessions: visits,
    bounce_rate: visits ? Math.min(1, (val(s.bounces) ?? 0) / visits) : undefined,
    avg_duration: visits ? (val(s.totaltime) ?? 0) / visits : undefined,
  }
}

/** Every day of the range, with zeros where Umami has no bucket. */
function days(range) {
  const out = []
  for (let t = ms(range.from); t <= ms(range.to); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10))
  return out
}

async function top(ctx, headers, base, query, types) {
  for (const type of types) {
    try {
      const rows = await get(ctx, headers, `${base}/metrics?${query}&type=${type}&limit=10`)
      return (Array.isArray(rows) ? rows : rows?.data ?? []).map((r) => ({ key: String(r.x ?? '(none)'), value: Number(r.y) || 0 }))
    } catch (e) {
      if (e.status !== 400 && e.status !== 404) throw e
    }
  }
  return []
}

async function one(ctx, headersFor, source, req) {
  const host = (source.host ?? hostsOf(ctx)[0])?.replace(/\/+$/, '')
  if (!host) throw new Error('no Umami host: set options.hosts in malha.plugins.json')
  const headers = await headersFor(host)
  const base = `${api(host)}/websites/${encodeURIComponent(source.id)}`
  const q = (r) => `startAt=${ms(r.from)}&endAt=${ms(r.to, true)}`
  const viewsOf = (r) => get(ctx, headers, `${base}/pageviews?${q(r)}&unit=day&timezone=${encodeURIComponent(req.timezone || 'UTC')}`)
  const [now, before, views, previousViews] = await Promise.all([get(ctx, headers, `${base}/stats?${q(req.range)}`), get(ctx, headers, `${base}/stats?${q(req.previous)}`), viewsOf(req.range), viewsOf(req.previous)])
  const byDay = (list) => new Map((list ?? []).map((p) => [String(p.x).slice(0, 10), Number(p.y) || 0]))
  const seriesOf = (range, v) => {
    const pv = byDay(v.pageviews)
    const vis = byDay(v.sessions)
    return days(range).map((date) => ({ date, visitors: vis.get(date) ?? 0, pageviews: pv.get(date) ?? 0 }))
  }
  const [pages, referrers, countries, devices, browsers, os] = await Promise.all([
    top(ctx, headers, base, q(req.range), ['path', 'url']),
    top(ctx, headers, base, q(req.range), ['referrer']),
    top(ctx, headers, base, q(req.range), ['country']),
    top(ctx, headers, base, q(req.range), ['device']),
    top(ctx, headers, base, q(req.range), ['browser']),
    top(ctx, headers, base, q(req.range), ['os']),
  ])
  return {
    totals: totals(now),
    previous: totals(before),
    series: seriesOf(req.range, views),
    previousSeries: seriesOf(req.previous, previousViews),
    top: { pages, referrers, countries, devices, browsers, os },
  }
}

export default {
  async analytics(ctx, req) {
    const headersFor = auth(ctx)
    const results = []
    for (const source of req.sources) {
      const base = { app: source.app, provider: 'umami', id: String(source.id) }
      try {
        results.push({ ...base, ok: true, ...(await one(ctx, headersFor, source, req)) })
      } catch (e) {
        results.push({ ...base, ok: false, error: e.message })
      }
    }
    return { results }
  },

  async link(ctx, { trackers }) {
    const hosts = hostsOf(ctx)
    const headersFor = auth(ctx)
    const sources = []
    const notes = []
    for (const t of trackers) {
      for (const u of t.umami) {
        let origin = new URL(u.script).origin
        if (origin === CLOUD_SCRIPT) origin = CLOUD
        if (!hosts.includes(origin)) {
          notes.push(`${t.app}: its Umami script comes from ${origin}; add it to options.hosts to read it`)
          continue
        }
        try {
          await get(ctx, await headersFor(origin), `${api(origin)}/websites/${encodeURIComponent(u.website)}`)
          sources.push({ app: t.app, source: { provider: 'umami', id: u.website, ...(origin !== hosts[0] ? { host: origin } : {}) } })
        } catch (e) {
          notes.push(`${t.app}: website ${u.website} on ${origin}: ${e.message}`)
        }
      }
    }
    return { sources, notes }
  },
}
