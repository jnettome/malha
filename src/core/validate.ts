import { registeredDomain } from './hostnames.ts'
import type { Topology } from './types.ts'

export interface Findings {
  errors: string[]
  warnings: string[]
}

const asList = (endpoint: string | string[]) => (Array.isArray(endpoint) ? endpoint : [endpoint])

export const DOMAIN_WARN_DAYS = 30

/** Registered domain → who uses it ("app shop", "node w1"), from app domains and node hosts. */
export function domainUsers(t: Topology) {
  const usedBy = new Map<string, Set<string>>()
  const note = (host: string, who: string) => {
    const name = registeredDomain(host)
    usedBy.set(name, (usedBy.get(name) ?? new Set()).add(who))
  }
  for (const a of t.apps ?? []) for (const h of a.domains ?? []) note(h, `app ${a.id}`)
  for (const n of t.nodes) if (n.host && n.status !== 'retired') note(n.host, `node ${n.id}`)
  return usedBy
}

/** Whole days from today (local date) to a YYYY-MM-DD date; negative when it has passed. */
export function daysUntil(date: string, today: Date) {
  const start = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
  return Math.round((Date.parse(`${date}T00:00:00Z`) - start) / 86_400_000)
}

// Cross-reference checks the JSON Schema cannot express: unique ids, and every id that is
// referenced somewhere actually exists. Runs after schema validation.
export function checkReferences(t: Topology, today = new Date()): Findings {
  const errors: string[] = []
  const warnings: string[] = []

  const ids = <T extends { id: string }>(items: T[] | undefined, what: string) => {
    const set = new Set<string>()
    for (const item of items ?? []) {
      if (set.has(item.id)) errors.push(`${what} "${item.id}" is defined twice`)
      set.add(item.id)
    }
    return set
  }

  const providers = ids(t.providers, 'provider')
  const networks = ids(t.networks, 'network')
  const sites = ids(t.sites, 'site')
  const zones = ids(t.zones, 'zone')
  const nodes = ids(t.nodes, 'node')
  const apps = ids(t.apps, 'app')
  ids(t.flows, 'flow')

  for (const id of nodes) if (zones.has(id)) errors.push(`"${id}" is both a node and a zone; link endpoints need one meaning`)

  const endpoint = (id: string, where: string) => {
    if (!nodes.has(id) && !zones.has(id)) errors.push(`${where}: "${id}" is not a node or zone`)
  }
  const node = (id: string, where: string) => {
    if (!nodes.has(id)) errors.push(`${where}: "${id}" is not a node`)
  }
  const network = (id: string | undefined, where: string) => {
    if (id && !networks.has(id)) errors.push(`${where}: network "${id}" is not defined`)
  }

  for (const n of t.nodes) {
    const where = `node ${n.id}`
    if (!zones.has(n.zone)) errors.push(`${where}: zone "${n.zone}" is not defined`)
    if (n.provider && !providers.has(n.provider)) errors.push(`${where}: provider "${n.provider}" is not defined`)
    for (const net of n.networks ?? []) network(net, where)
    for (const site of n.site === undefined ? [] : asList(n.site))
      if (!sites.has(site)) errors.push(`${where}: site "${site}" is not defined`)
    const { pods } = n.usage ?? {}
    const max = n.hardware?.max_pods
    if (pods !== undefined && max !== undefined && pods > max) warnings.push(`${where}: ${pods} pods is over max_pods ${max}`)
  }

  const populated = new Set(t.nodes.map((n) => n.zone))
  for (const z of t.zones) if (!populated.has(z.id)) warnings.push(`zone ${z.id} has no nodes`)

  t.links?.forEach((l, i) => {
    const where = `links[${i}] (${l.label ?? l.kind})`
    for (const id of asList(l.from)) endpoint(id, `${where} from`)
    for (const id of asList(l.to)) endpoint(id, `${where} to`)
    network(l.via, where)
  })

  for (const a of t.apps ?? []) {
    const where = `app ${a.id}`
    for (const id of Object.keys(a.pods ?? {})) node(id, `${where} pods`)
    if (a.host) node(a.host, `${where} host`)
    for (const db of a.databases ?? []) for (const id of db.nodes) node(id, `${where} database ${db.name}`)
    for (const id of a.uses ?? []) node(id, `${where} uses`)
    for (const id of a.depends_on ?? []) if (!apps.has(id)) errors.push(`${where} depends_on: "${id}" is not an app`)
  }

  const domains = new Set<string>()
  for (const d of t.domains?.list ?? []) {
    const where = `domain ${d.name}`
    if (domains.has(d.name)) errors.push(`${where} is listed twice`)
    domains.add(d.name)
    for (const [field, id] of [['registrar', d.registrar], ['dns', d.dns]] as const)
      if (id && !providers.has(id)) errors.push(`${where} ${field}: provider "${id}" is not defined`)
  }

  // The domain standard: every domain something uses is listed, and the ones in use have a
  // tracked expiry that renews by itself.
  if (t.domains) {
    const usedBy = domainUsers(t)
    const listed = new Map(t.domains.list.map((d) => [d.name, d]))
    for (const [name, who] of usedBy)
      if (!listed.has(name)) warnings.push(`domain ${name}: used by ${[...who].join(', ')} but not listed in domains`)
    for (const d of t.domains.list) {
      const who = usedBy.get(d.name)
      const users = who ? [...who].join(', ') : ''
      if (who && !d.expires) warnings.push(`domain ${d.name}: serves ${users} but its expiry is not tracked (no registrar here)`)
      if (who && d.auto_renew === false) warnings.push(`domain ${d.name}: serves ${users} and auto-renew is off`)
      if (d.expires) {
        const days = daysUntil(d.expires, today)
        if (days < 0) warnings.push(`domain ${d.name}: expired ${-days} days ago`)
        else if (days <= DOMAIN_WARN_DAYS) warnings.push(`domain ${d.name}: expires in ${days} days${who ? ` and serves ${users}` : ''}`)
      }
    }
  }

  const zoneOf = new Map(t.nodes.map((n) => [n.id, n.zone]))
  const covers = (ends: string[], id: string) => ends.includes(id) || ends.includes(zoneOf.get(id) ?? '')
  for (const f of t.flows ?? []) {
    f.steps.forEach((s, i) => {
      const where = `flow ${f.id} step ${i + 1}`
      endpoint(s.from, where)
      endpoint(s.to, where)
      network(s.via, where)
      // A step with `via` rides a network (e.g. the pod overlay) rather than a declared link.
      if (s.via) return
      const linked = t.links?.some((l) => {
        const from = asList(l.from)
        const to = asList(l.to)
        return (covers(from, s.from) && covers(to, s.to)) || (covers(from, s.to) && covers(to, s.from))
      })
      if (!linked) warnings.push(`${where}: no link between ${s.from} and ${s.to}; the viewer draws a dashed hop`)
    })
  }

  return { errors, warnings }
}
