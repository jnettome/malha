// PostHog, cloud or self-hosted. options.hosts lists the app hosts ("https://us.posthog.com",
// "https://eu.posthog.com", or yours). Personal API keys with Organization, Project and Query read:
// POSTHOG_PERSONAL_API_KEY, or ~/.config/malha/posthog-key. Projects under several accounts take one
// key each: one per line in the file (a "# label" after a key names it in messages), or separated
// by commas in the variable. Each project is read with whichever key can see it.
// Counts come from $pageview events, filtered to the app's hostnames, since one project often
// collects several sites.

const hostsOf = (ctx) => [ctx.options.hosts ?? []].flat().map((h) => String(h).replace(/\/+$/, ''))
/** Where events are sent (us.i.posthog.com) → where the API answers (us.posthog.com). */
const INGESTION = { 'https://us.i.posthog.com': 'https://us.posthog.com', 'https://eu.i.posthog.com': 'https://eu.posthog.com', 'https://app.posthog.com': 'https://us.posthog.com' }

/** The personal API keys, as { key, label }; never put a key itself in a message. */
async function keys(ctx) {
  const parse = (text) =>
    text
      .split(/\n/)
      .flatMap((line) => {
        const [body, ...comment] = line.split('#')
        return body.split(/[\s,]+/).filter(Boolean).map((key) => ({ key, label: comment.join('#').trim() }))
      })
      .map((k, i) => ({ key: k.key, label: k.label || `key ${i + 1}` }))
  const env = await ctx.env('POSTHOG_PERSONAL_API_KEY')
  let list = env ? parse(env) : []
  if (!list.length) {
    try {
      list = parse(await ctx.readFile('~/.config/malha/posthog-key'))
    } catch (e) {
      if (e.code !== 'MALHA_NOT_FOUND') throw e
    }
  }
  if (!list.length) throw new Error('no PostHog personal API key: set POSTHOG_PERSONAL_API_KEY, or put it in ~/.config/malha/posthog-key (one per line for several accounts)')
  return list
}

/** The key that last answered for a project, so the others are tried only once. */
const chosen = new Map()

/** A HogQL condition matching the app's hostnames; "*.x" matches every subdomain of x. */
function hostFilter(hostnames) {
  const ok = hostnames.filter((h) => /^(\*\.)?[a-z0-9.-]+$/i.test(h))
  if (!ok.length) return 'true'
  const exact = ok.filter((h) => !h.startsWith('*.')).map((h) => `'${h.toLowerCase()}'`)
  const wild = ok.filter((h) => h.startsWith('*.')).map((h) => `endsWith(properties.$host, '${h.slice(1).toLowerCase()}')`)
  return `(${[exact.length ? `properties.$host IN (${exact.join(', ')})` : '', ...wild].filter(Boolean).join(' OR ')})`
}

const between = (r) => `timestamp >= toDateTime('${r.from} 00:00:00') AND timestamp < toDateTime('${r.to} 00:00:00') + INTERVAL 1 DAY`

async function query(ctx, list, host, project, hogql) {
  const id = `${host} ${project}`
  const known = chosen.get(id)
  const denied = []
  for (const k of known ? [known] : list) {
    const res = await ctx.fetch(`${host}/api/projects/${encodeURIComponent(project)}/query/`, {
      method: 'POST',
      headers: { authorization: `Bearer ${k.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query: hogql } }),
    })
    // Another account's key: try the next one.
    if (!known && [401, 403, 404].includes(res.status)) {
      denied.push(`${k.label} ${res.status}`)
      continue
    }
    if (!res.ok) throw new Error(`PostHog answered ${res.status}: ${(await res.text()).slice(0, 160)}`)
    chosen.set(id, k)
    return (await res.json()).results ?? []
  }
  throw new Error(`no key can read project ${project} on ${host} (${denied.join(', ')})`)
}

async function one(ctx, list, source, req) {
  const host = (source.host ?? hostsOf(ctx)[0])?.replace(/\/+$/, '')
  if (!host) throw new Error('no PostHog host: set options.hosts in malha.plugins.json')
  const where = (r) => `event = '$pageview' AND ${between(r)} AND ${hostFilter(source.hostnames)}`
  const q = (sql) => query(ctx, list, host, source.id, sql)
  const totalsOf = async (r) => {
    const [[visitors, pageviews, sessions] = []] = await q(`SELECT count(DISTINCT person_id), count(), count(DISTINCT properties.$session_id) FROM events WHERE ${where(r)}`)
    return { visitors: Number(visitors) || 0, pageviews: Number(pageviews) || 0, sessions: Number(sessions) || 0 }
  }
  const topOf = async (expr) => (await q(`SELECT ${expr} AS k, count() AS v FROM events WHERE ${where(req.range)} GROUP BY k ORDER BY v DESC LIMIT 10`)).map(([k, v]) => ({ key: String(k ?? '(none)'), value: Number(v) || 0 }))
  // The first query finds the key that can read this project; the rest go in parallel with it.
  const totals = await totalsOf(req.range)
  const [previous, series, pages, referrers, countries, devices] = await Promise.all([
    totalsOf(req.previous),
    q(`SELECT toDate(timestamp) AS d, count(DISTINCT person_id), count() FROM events WHERE ${where(req.range)} GROUP BY d ORDER BY d`),
    topOf('properties.$pathname'),
    topOf("if(properties.$referring_domain = '$direct', '(direct)', properties.$referring_domain)"),
    topOf('properties.$geoip_country_code'),
    topOf('properties.$device_type'),
  ])
  // Every hostname in the project, unfiltered, so Malha can say which ones no app lists.
  const allHosts = (await q(`SELECT properties.$host AS k, count() AS v FROM events WHERE event = '$pageview' AND ${between(req.range)} GROUP BY k ORDER BY v DESC LIMIT 25`)).map(([k, v]) => ({ key: String(k ?? ''), value: Number(v) || 0 })).filter((h) => h.key)
  const byDay = new Map(series.map(([d, v, p]) => [String(d).slice(0, 10), { visitors: Number(v) || 0, pageviews: Number(p) || 0 }]))
  const days = []
  for (let t = Date.parse(`${req.range.from}T00:00:00Z`); t <= Date.parse(`${req.range.to}T00:00:00Z`); t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10)
    days.push({ date, ...(byDay.get(date) ?? { visitors: 0, pageviews: 0 }) })
  }
  // No pageview anywhere in the project: say what it does collect, which is usually the reason.
  let note
  if (!totals.pageviews && !allHosts.length) {
    const events = await q(`SELECT event AS k, count() AS v FROM events WHERE ${between(req.range)} GROUP BY k ORDER BY v DESC LIMIT 5`)
    note = events.length
      ? `no $pageview events in this period, only ${events.map(([k, v]) => `${k} (${Number(v) || 0})`).join(', ')}: turn on capture_pageview in posthog-js, or this project measures something else`
      : 'no events at all in this period: check that the snippet is on the live site and sends to this project'
  }
  return { totals, previous, series: days, top: { pages, referrers, countries, devices }, allHosts, ...(note ? { note } : {}) }
}

export default {
  async analytics(ctx, req) {
    const list = await keys(ctx)
    const results = []
    for (const source of req.sources) {
      const base = { app: source.app, provider: 'posthog', id: String(source.id) }
      try {
        results.push({ ...base, ok: true, ...(await one(ctx, list, source, req)) })
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
    const list = await keys(ctx)
    const notes = []
    const listings = new Map()
    // Every project a key can see on a host. /api/projects/ is only the key's current
    // organization, so walk the organizations too (that needs Organization: Read).
    const projectsOn = (host, k) => {
      const id = `${host} ${k.key}`
      if (!listings.has(id))
        listings.set(id, (async () => {
          const get = async (path) => {
            const res = await ctx.fetch(`${host}${path}`, { headers: { authorization: `Bearer ${k.key}` } })
            if (!res.ok) throw new Error(`${host} answered ${res.status} for ${path.split('?')[0]}`)
            return (await res.json()).results ?? []
          }
          const all = await get('/api/projects/?limit=200')
          let orgs = []
          try {
            orgs = await get('/api/organizations/?limit=100')
          } catch (e) {
            notes.push(`${k.label}: ${e.message}: only its current organization was searched (give it Organization: Read for the rest)`)
          }
          for (const org of orgs) {
            try {
              all.push(...(await get(`/api/organizations/${encodeURIComponent(org.id)}/projects/?limit=200`)))
            } catch (e) {
              notes.push(`${k.label}, organization ${org.name ?? org.id}: ${e.message}`)
            }
          }
          return all
        })())
      return listings.get(id)
    }
    const sources = []
    for (const t of wanted) {
      for (const p of t.posthog) {
        const sent = p.host ? new URL(p.host).origin : undefined
        const likely = sent ? (INGESTION[sent] ?? sent) : hosts[0]
        // A project key is unique, so look on every configured host with every key: the likely
        // host first, the rest for pages that send through a reverse proxy, which hides the host.
        const order = [...new Set([likely, ...hosts])].filter((h) => hosts.includes(h))
        let found = false
        search: for (const host of order) {
          for (const k of list) {
            let projects
            try {
              projects = await projectsOn(host, k)
            } catch (e) {
              notes.push(`${k.label}: ${e.message}`)
              continue
            }
            const match = projects.find((x) => x.api_token === p.key)
            if (match) {
              sources.push({ app: t.app, source: { provider: 'posthog', id: match.id, ...(host !== hosts[0] ? { host } : {}) } })
              found = true
              break search
            }
          }
        }
        if (!found)
          notes.push(`${t.app}: no project with the key ${p.key.slice(0, 10)}… on ${order.join(', ') || 'options.hosts (empty)'}${list.length > 1 ? ` with any of the ${list.length} keys` : ''}${sent && !hosts.includes(likely) ? `; its events go to ${sent}${INGESTION[sent] ? `, so add ${likely} to options.hosts` : ''}` : ''}`)
      }
    }
    return { sources, notes: [...new Set(notes)] }
  },
}
