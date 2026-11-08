// PostHog, cloud or self-hosted. options.hosts lists the app hosts ("https://us.posthog.com",
// "https://eu.posthog.com", or yours). A personal API key with read access to queries and projects:
// POSTHOG_PERSONAL_API_KEY, or ~/.config/malha/posthog-key.
// Counts come from $pageview events, filtered to the app's hostnames, since one project often
// collects several sites.

const hostsOf = (ctx) => [ctx.options.hosts ?? []].flat().map((h) => String(h).replace(/\/+$/, ''))
/** Where events are sent (us.i.posthog.com) → where the API answers (us.posthog.com). */
const INGESTION = { 'https://us.i.posthog.com': 'https://us.posthog.com', 'https://eu.i.posthog.com': 'https://eu.posthog.com', 'https://app.posthog.com': 'https://us.posthog.com' }

async function key(ctx) {
  const env = await ctx.env('POSTHOG_PERSONAL_API_KEY')
  if (env) return env.trim()
  try {
    return (await ctx.readFile('~/.config/malha/posthog-key')).trim()
  } catch (e) {
    if (e.code === 'MALHA_NOT_FOUND') throw new Error('no PostHog personal API key: set POSTHOG_PERSONAL_API_KEY, or put it in ~/.config/malha/posthog-key')
    throw e
  }
}

/** A HogQL condition matching the app's hostnames; "*.x" matches every subdomain of x. */
function hostFilter(hostnames) {
  const ok = hostnames.filter((h) => /^(\*\.)?[a-z0-9.-]+$/i.test(h))
  if (!ok.length) return 'true'
  const exact = ok.filter((h) => !h.startsWith('*.')).map((h) => `'${h.toLowerCase()}'`)
  const wild = ok.filter((h) => h.startsWith('*.')).map((h) => `endsWith(properties.$host, '${h.slice(1).toLowerCase()}')`)
  return `(${[exact.length ? `properties.$host IN (${exact.join(', ')})` : '', ...wild].filter(Boolean).join(' OR ')})`
}

const between = (r) => `timestamp >= toDateTime('${r.from} 00:00:00') AND timestamp < toDateTime('${r.to} 00:00:00') + INTERVAL 1 DAY`

async function query(ctx, auth, host, project, hogql) {
  const res = await ctx.fetch(`${host}/api/projects/${encodeURIComponent(project)}/query/`, {
    method: 'POST',
    headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query: hogql } }),
  })
  if (!res.ok) throw new Error(`PostHog answered ${res.status}: ${(await res.text()).slice(0, 160)}`)
  return (await res.json()).results ?? []
}

async function one(ctx, auth, source, req) {
  const host = (source.host ?? hostsOf(ctx)[0])?.replace(/\/+$/, '')
  if (!host) throw new Error('no PostHog host: set options.hosts in malha.plugins.json')
  const where = (r) => `event = '$pageview' AND ${between(r)} AND ${hostFilter(source.hostnames)}`
  const q = (sql) => query(ctx, auth, host, source.id, sql)
  const totalsOf = async (r) => {
    const [[visitors, pageviews, sessions] = []] = await q(`SELECT count(DISTINCT person_id), count(), count(DISTINCT properties.$session_id) FROM events WHERE ${where(r)}`)
    return { visitors: Number(visitors) || 0, pageviews: Number(pageviews) || 0, sessions: Number(sessions) || 0 }
  }
  const topOf = async (expr) => (await q(`SELECT ${expr} AS k, count() AS v FROM events WHERE ${where(req.range)} GROUP BY k ORDER BY v DESC LIMIT 10`)).map(([k, v]) => ({ key: String(k ?? '(none)'), value: Number(v) || 0 }))
  const [totals, previous, series, pages, referrers, countries, devices] = await Promise.all([
    totalsOf(req.range),
    totalsOf(req.previous),
    q(`SELECT toDate(timestamp) AS d, count(DISTINCT person_id), count() FROM events WHERE ${where(req.range)} GROUP BY d ORDER BY d`),
    topOf('properties.$pathname'),
    topOf("if(properties.$referring_domain = '$direct', '(direct)', properties.$referring_domain)"),
    topOf('properties.$geoip_country_code'),
    topOf('properties.$device_type'),
  ])
  const byDay = new Map(series.map(([d, v, p]) => [String(d).slice(0, 10), { visitors: Number(v) || 0, pageviews: Number(p) || 0 }]))
  const days = []
  for (let t = Date.parse(`${req.range.from}T00:00:00Z`); t <= Date.parse(`${req.range.to}T00:00:00Z`); t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10)
    days.push({ date, ...(byDay.get(date) ?? { visitors: 0, pageviews: 0 }) })
  }
  return { totals, previous, series: days, top: { pages, referrers, countries, devices } }
}

export default {
  async analytics(ctx, req) {
    const auth = await key(ctx)
    const results = []
    for (const source of req.sources) {
      const base = { app: source.app, provider: 'posthog', id: String(source.id) }
      try {
        results.push({ ...base, ok: true, ...(await one(ctx, auth, source, req)) })
      } catch (e) {
        results.push({ ...base, ok: false, error: e.message })
      }
    }
    return { results }
  },

  async link(ctx, { trackers }) {
    const hosts = hostsOf(ctx)
    const wanted = trackers.filter((t) => t.posthog.length)
    if (!wanted.length) return { sources: [] }
    const auth = await key(ctx)
    const notes = []
    const projects = new Map()
    // Every project the key can see on a host. /api/projects/ is only the key's current
    // organization, so walk the organizations too (that needs Organization: Read).
    const projectsOn = (host) => {
      if (!projects.has(host))
        projects.set(host, (async () => {
          const get = async (path) => {
            const res = await ctx.fetch(`${host}${path}`, { headers: { authorization: `Bearer ${auth}` } })
            if (!res.ok) throw new Error(`${host} answered ${res.status} for ${path.split('?')[0]}`)
            return (await res.json()).results ?? []
          }
          const all = await get('/api/projects/?limit=200')
          let orgs = []
          try {
            orgs = await get('/api/organizations/?limit=100')
          } catch (e) {
            notes.push(`${e.message}: only the key's current organization was searched (give the key Organization: Read for the rest)`)
          }
          for (const org of orgs) {
            try {
              all.push(...(await get(`/api/organizations/${encodeURIComponent(org.id)}/projects/?limit=200`)))
            } catch (e) {
              notes.push(`organization ${org.name ?? org.id}: ${e.message}`)
            }
          }
          return all
        })())
      return projects.get(host)
    }
    const sources = []
    for (const t of wanted) {
      for (const p of t.posthog) {
        const sent = p.host ? new URL(p.host).origin : undefined
        const likely = sent ? (INGESTION[sent] ?? sent) : hosts[0]
        // A project key is unique, so look on every configured host: the likely one first, and the
        // rest for pages that send through a reverse proxy, which hides where events end up.
        const order = [...new Set([likely, ...hosts])].filter((h) => hosts.includes(h))
        let found = false
        for (const host of order) {
          let list
          try {
            list = await projectsOn(host)
          } catch (e) {
            notes.push(`${t.app}: ${e.message}`)
            continue
          }
          const match = list.find((x) => x.api_token === p.key)
          if (match) {
            sources.push({ app: t.app, source: { provider: 'posthog', id: match.id, ...(host !== hosts[0] ? { host } : {}) } })
            found = true
            break
          }
        }
        if (!found)
          notes.push(`${t.app}: no project with the key ${p.key.slice(0, 10)}… on ${order.join(', ') || 'options.hosts (empty)'}${sent && !hosts.includes(likely) ? `; its events go to ${sent}${INGESTION[sent] ? `, so add ${likely} to options.hosts` : ''}` : ''}`)
      }
    }
    return { sources, notes: [...new Set(notes)] }
  },
}
