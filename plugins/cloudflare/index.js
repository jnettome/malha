// Cloudflare as the DNS host. The token needs Zone → Zone → Read, and Zone → DNS → Read for `records`.

const API = 'https://api.cloudflare.com/client/v4'
const TWO_LEVEL = /\.(com|net|org|gov|edu|co|ac|ne|or)\.[a-z]{2}$/
const registered = (host) => host.split('.').slice(TWO_LEVEL.test(host) ? -3 : -2).join('.')
const list = (v) => (v === undefined ? [] : [v].flat())

/** How many labels two hostnames share at the end: beta.shop.acme.example and shop.acme.example share 3. */
function shared(a, b) {
  const x = a.split('.').reverse()
  const y = b.split('.').reverse()
  let n = 0
  while (n < x.length && n < y.length && x[n] === y[n]) n++
  return n
}

async function token(ctx) {
  const value = await ctx.env('CLOUDFLARE_API_TOKEN')
  if (value) return value.trim()
  for (const file of ['~/.config/malha/cloudflare-token', '~/.config/cloudflare/token']) {
    try {
      return (await ctx.readFile(file)).trim()
    } catch (e) {
      if (e.code !== 'MALHA_NOT_FOUND') throw e
    }
  }
  throw new Error('no Cloudflare API token: set CLOUDFLARE_API_TOKEN, or put it in ~/.config/malha/cloudflare-token')
}

/** Every page of a list endpoint. */
async function pages(ctx, auth, path, perPage) {
  const all = []
  for (let page = 1; ; page++) {
    const sep = path.includes('?') ? '&' : '?'
    const res = await ctx.fetch(`${API}${path}${sep}per_page=${perPage}&page=${page}`, { headers: { authorization: `Bearer ${auth}` } })
    const body = await res.json().catch(() => ({}))
    if (!body.success) throw new Error(`Cloudflare: ${body.errors?.map((e) => e.message).join(', ') || `HTTP ${res.status}`}`)
    all.push(...body.result)
    if (page >= (body.result_info?.total_pages ?? 1)) break
  }
  return all
}

const zones = async (ctx, auth) =>
  (await pages(ctx, auth, '/zones', 50)).map((z) => ({
    id: z.id,
    name: z.name.toLowerCase(),
    status: z.status,
    plan: (z.plan?.legacy_id ?? z.plan?.name?.split(' ')[0] ?? 'unknown').toLowerCase(),
  }))

const providerChange = (topology, provider) =>
  (topology.providers ?? []).some((p) => p.id === provider) ? [] : [{ add: 'providers', item: { id: provider, name: 'Cloudflare', kind: 'saas' }, why: 'the domains name it as their DNS host' }]

export default {
  commands: {
    async zones(ctx) {
      const provider = typeof ctx.options.provider === 'string' ? ctx.options.provider : 'cloudflare'
      const [topology, found] = await Promise.all([ctx.topology(), token(ctx).then((auth) => zones(ctx, auth))])
      const changes = providerChange(topology, provider)
      const current = new Map((topology.domains?.list ?? []).map((d) => [d.name, d]))
      for (const z of found) {
        const have = current.get(z.name)
        if (!have) {
          changes.push({ add: 'domains', item: { name: z.name, dns: provider, plan: z.plan }, why: 'a zone in the Cloudflare account' })
          continue
        }
        const set = {}
        if (have.dns !== provider) set.dns = provider
        if (have.plan !== z.plan) set.plan = z.plan
        if (Object.keys(set).length) changes.push({ update: 'domains', id: z.name, set })
      }
      const seen = new Set(found.map((z) => z.name))
      const gone = [...current.values()].filter((d) => d.dns === provider && !seen.has(d.name)).map((d) => d.name)
      const inactive = found.filter((z) => z.status !== 'active').map((z) => `${z.name} (${z.status})`)
      if (topology.domains) changes.push({ set: { 'domains.checked': ctx.today }, why: 'checked against Cloudflare' })
      const lines = [`${found.length} zones in the Cloudflare account.`]
      if (inactive.length) lines.push(`Not active: ${inactive.join(', ')}`)
      if (gone.length) lines.push(`DNS on ${provider} here but not a zone in this account (another account?): ${gone.join(', ')}`)
      return { message: lines.join('\n'), changes }
    },

    async records(ctx) {
      const auth = await token(ctx)
      const [topology, found] = await Promise.all([ctx.topology(), zones(ctx, auth)])
      const records = []
      for (const z of found) {
        for (const r of await pages(ctx, auth, `/zones/${z.id}/dns_records`, 500))
          if (['A', 'AAAA', 'CNAME'].includes(r.type) && !r.name.startsWith('_')) records.push({ name: r.name.toLowerCase(), type: r.type, content: r.content.toLowerCase().replace(/\.$/, ''), proxied: r.proxied, zone: z.name })
      }
      const byName = new Map()
      for (const r of records) byName.set(r.name, [...(byName.get(r.name) ?? []), r])
      const nodeByAddress = new Map()
      for (const n of topology.nodes) for (const a of Object.values(n.addresses ?? {})) nodeByAddress.set(a, n)
      const nodeByHost = new Map(topology.nodes.filter((n) => n.host).map((n) => [n.host.toLowerCase(), n]))
      const apps = topology.apps ?? []
      const owns = (app, host) => (app.domains ?? []).some((d) => d === host || (d.startsWith('*.') && host.endsWith(d.slice(1))))

      /** Where a name ends up: a node, an address no node has, or a name outside the account. */
      const resolve = (name, depth = 0) => {
        for (const r of byName.get(name) ?? []) {
          if (r.type !== 'CNAME') return nodeByAddress.has(r.content) ? { node: nodeByAddress.get(r.content) } : { address: r.content }
          if (nodeByHost.has(r.content)) return { node: nodeByHost.get(r.content) }
          if (byName.has(r.content) && depth < 5) return resolve(r.content, depth + 1)
          return { elsewhere: r.content }
        }
        return {}
      }

      const additions = new Map()
      const reached = new Map()
      const dangling = []
      const unclaimed = []
      const outside = []
      let claimed = 0
      for (const name of [...byName.keys()].sort()) {
        const where = resolve(name)
        if (where.node?.status === 'retired') {
          dangling.push(`${name} → ${where.node.id}, which is retired`)
          continue
        }
        if (where.address) {
          outside.push(`${name} → ${where.address}`)
          continue
        }
        if (where.node) reached.set(where.node.id, [...(reached.get(where.node.id) ?? []), name])
        if (apps.some((a) => owns(a, name)) || nodeByHost.has(name)) {
          claimed++
          continue
        }
        if (!where.node) continue
        // The app whose names are closest: most trailing labels in common (shop.acme.example beats
        // acme.example for beta.shop.acme.example). Only a clear winner gets the name.
        const zone = registered(name)
        const score = (a) => Math.max(0, ...(a.domains ?? []).filter((d) => registered(d.replace(/^\*\./, '')) === zone).map((d) => shared(name, d.replace(/^\*\./, ''))))
        const ranked = apps.map((a) => [a, score(a)]).filter(([, s]) => s > 0).sort((x, y) => y[1] - x[1])
        if (ranked.length && (ranked.length === 1 || ranked[0][1] > ranked[1][1])) additions.set(ranked[0][0].id, [...(additions.get(ranked[0][0].id) ?? []), name])
        else unclaimed.push(`${name} → ${where.node.id}${ranked.length ? ` (${ranked.filter(([, s]) => s === ranked[0][1]).map(([a]) => a.id).join(' or ')}?)` : ''}`)
      }

      const changes = []
      for (const [id, names] of additions) {
        const app = apps.find((a) => a.id === id)
        changes.push({ update: 'apps', id, set: { domains: [...(app.domains ?? []), ...names] }, why: `DNS points them at the machines, and ${app.name} has the closest names` })
      }
      // A machine that names point at, with no HTTP link reaching it, gets one from the public.
      const users = topology.nodes.find((n) => n.kind === 'users')
      const zoneOf = (id) => topology.nodes.find((n) => n.id === id)?.zone
      for (const [id, names] of reached) {
        const linked = (topology.links ?? []).some((l) => l.kind === 'http' && list(l.to).some((e) => e === id || e === zoneOf(id)))
        if (!linked && users) changes.push({ add: 'links', item: { from: users.id, to: id, kind: 'http', ports: [80, 443], label: `${names.slice(0, 2).join(', ')}${names.length > 2 ? ` and ${names.length - 2} more` : ''} (from DNS)` }, why: `DNS points ${names.length} name(s) at ${id}` })
      }

      const missing = []
      const zoneNames = new Set(found.map((z) => z.name))
      for (const a of apps)
        for (const d of a.domains ?? []) {
          if (d.startsWith('*.') || !zoneNames.has(registered(d))) continue
          const wildcard = `*.${d.split('.').slice(1).join('.')}`
          if (!byName.has(d) && !byName.has(wildcard)) missing.push(`${d} (${a.id})`)
        }

      const lines = [`${records.length} A, AAAA and CNAME records in ${found.length} zones; ${claimed} belong to an app or a machine in the file.`]
      if (dangling.length) lines.push(`Point at retired machines; remove them before someone else gets the address: ${dangling.join('; ')}`)
      if (outside.length) lines.push(`Point at addresses no machine in the file has: ${outside.join('; ')}`)
      if (unclaimed.length) lines.push(`Reach a machine but no app lists them: ${unclaimed.join('; ')}`)
      if (missing.length) lines.push(`Listed by an app, with no DNS record: ${missing.join(', ')}`)
      return { message: lines.join('\n'), changes }
    },
  },
}
