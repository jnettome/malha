import { model } from '../model/model.ts'
import type { InfraNode, LinkKind, Site } from '../../core/types.ts'

export const sites: Site[] = model.t.sites ?? []
export const siteById = new Map(sites.map((s) => [s.id, s]))

export const sitesOf = (n: InfraNode) => (n.site === undefined ? [] : Array.isArray(n.site) ? n.site : [n.site])

const placed = model.nodes.filter((n) => n.status !== 'retired')

/** Nodes with no site: anycast services and places nobody has pinned down. */
export const unplaced = placed.filter((n) => sitesOf(n).length === 0)

export interface Datacenter {
  /** Provider id, or `unknown`. */
  id: string
  name: string
  nodes: InfraNode[]
}

/** A site's machines grouped by who hosts them. */
export function datacenters(siteId: string): Datacenter[] {
  const groups = new Map<string, InfraNode[]>()
  for (const n of placed) {
    if (!sitesOf(n).includes(siteId)) continue
    const id = n.provider ?? 'unknown'
    groups.set(id, [...(groups.get(id) ?? []), n])
  }
  return [...groups].map(([id, nodes]) => ({ id, name: model.providerById.get(id)?.name ?? 'Unknown provider', nodes }))
}

interface Flow {
  id: string
  kind: LinkKind
  labels: string[]
  /** Node-level hops, e.g. "w1-under → AWS S3". */
  hops: string[]
}

/** Traffic between two sites, in the direction the data moves. */
export interface SiteArc extends Flow {
  from: string
  to: string
}

/** Traffic between two datacenters at the same site. */
export interface DcLink extends Flow {
  site: string
  from: string
  to: string
}

function collect() {
  const arcs = new Map<string, SiteArc>()
  const dcLinks = new Map<string, DcLink>()
  const add = <T extends Flow>(map: Map<string, T>, id: string, base: Omit<T, 'labels' | 'hops'>, label: string | undefined, hop: string) => {
    const entry = map.get(id) ?? ({ ...base, labels: [], hops: [] } as unknown as T)
    if (label && !entry.labels.includes(label)) entry.labels.push(label)
    if (!entry.hops.includes(hop)) entry.hops.push(hop)
    map.set(id, entry)
  }
  const members = (endpoint: string) => model.zoneMembers.get(endpoint) ?? [endpoint]
  const live = (id: string) => {
    const n = model.nodeById.get(id)
    return n && n.status !== 'retired' ? n : undefined
  }

  for (const e of model.edges) {
    for (const s of members(e.source)) {
      for (const t of members(e.target)) {
        const sn = live(s)
        const tn = live(t)
        if (!sn || !tn) continue
        const hop = `${sn.name} → ${tn.name}`
        for (const a of sitesOf(sn)) {
          for (const b of sitesOf(tn)) {
            if (a !== b) {
              add(arcs, `${a}>${b}:${e.kind}`, { id: `${a}>${b}:${e.kind}`, from: a, to: b, kind: e.kind }, e.link.label, hop)
              continue
            }
            const da = sn.provider ?? 'unknown'
            const db = tn.provider ?? 'unknown'
            if (da === db) continue
            const id = `${a}:${da}>${db}:${e.kind}`
            add(dcLinks, id, { id, site: a, from: da, to: db, kind: e.kind }, e.link.label, hop)
          }
        }
      }
    }
  }
  return { arcs: [...arcs.values()], dcLinks: [...dcLinks.values()] }
}

export const { arcs, dcLinks } = collect()

/** Datacenters at a site that are peers on an overlay network: they share the mesh. */
export function meshPeers(siteId: string, network: string) {
  return datacenters(siteId)
    .filter((dc) => dc.nodes.some((n) => n.networks?.includes(network)))
    .map((dc) => dc.id)
}
