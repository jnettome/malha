import { topology } from '../source.ts'
import type { App, Database, Flow, FlowStep, InfraNode, Link, LinkKind, Network, Provider, Topology, Zone } from '../../core/types.ts'

// One drawable connection: a link expanded to a single source → target pair.
export interface Edge {
  id: string
  link: Link
  source: string
  target: string
  kind: LinkKind
}

export interface Placement {
  app: App
  pods: number
  databases: Database[]
  hosted: boolean
}

export interface StepMatch {
  edge: Edge
  reversed: boolean
}

export interface SearchEntry {
  type: 'node' | 'app' | 'domain'
  id: string
  label: string
  detail: string
  haystack: string
}

const asList = (endpoint: string | string[]) => (Array.isArray(endpoint) ? endpoint : [endpoint])
export const notesOf = (notes: string | string[] | undefined) => (notes === undefined ? [] : asList(notes))

function build(t: Topology) {
  const nodes = t.nodes
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const zoneById = new Map(t.zones.map((z) => [z.id, z]))
  const providerById = new Map((t.providers ?? []).map((p) => [p.id, p]))
  const networkById = new Map((t.networks ?? []).map((n) => [n.id, n]))
  const appById = new Map((t.apps ?? []).map((a) => [a.id, a]))

  const zoneMembers = new Map<string, string[]>(t.zones.map((z) => [z.id, []]))
  for (const n of nodes) zoneMembers.get(n.zone)?.push(n.id)

  const edges: Edge[] = []
  ;(t.links ?? []).forEach((link, i) => {
    for (const source of asList(link.from))
      for (const target of asList(link.to))
        edges.push({ id: `l${i}:${source}>${target}`, link, source, target, kind: link.kind })
  })

  const placements = new Map<string, Placement[]>()
  for (const app of t.apps ?? []) {
    const ids = new Set([...Object.keys(app.pods ?? {}), ...(app.databases ?? []).flatMap((d) => d.nodes)])
    if (app.host) ids.add(app.host)
    for (const id of ids) {
      const list = placements.get(id) ?? []
      list.push({
        app,
        pods: app.pods?.[id] ?? 0,
        databases: (app.databases ?? []).filter((d) => d.nodes.includes(id)),
        hosted: app.host === id,
      })
      placements.set(id, list)
    }
  }

  const search: SearchEntry[] = [
    ...nodes.map((n) => ({
      type: 'node' as const,
      id: n.id,
      label: n.name,
      detail: [n.host, n.addresses?.wg, n.addresses?.public].filter(Boolean).join(' · ') || n.kind,
      haystack: [n.id, n.name, n.host, ...Object.values(n.addresses ?? {}), ...(n.runs ?? [])].join(' ').toLowerCase(),
    })),
    ...(t.apps ?? []).map((a) => ({
      type: 'app' as const,
      id: a.id,
      label: a.name,
      detail: `${a.category} · ${a.domains?.length ?? 0} domains`,
      haystack: [a.id, a.name, ...[a.namespace ?? []].flat()].join(' ').toLowerCase(),
    })),
    ...(t.apps ?? []).flatMap((a) =>
      (a.domains ?? []).map((d) => ({ type: 'domain' as const, id: a.id, label: d, detail: a.name, haystack: d.toLowerCase() })),
    ),
  ]

  return { t, nodes, nodeById, zoneById, providerById, networkById, appById, zoneMembers, edges, placements, search }
}

export const model = build(topology)
export type Model = typeof model

export const meta = model.t.meta
export const apps: App[] = model.t.apps ?? []
export const flows: Flow[] = model.t.flows ?? []
export const zones: Zone[] = model.t.zones
export const providers: Provider[] = model.t.providers ?? []
export const networks: Network[] = model.t.networks ?? []

export const node = (id: string): InfraNode | undefined => model.nodeById.get(id)

/** True when `endpoint` is `nodeId` itself or the zone that holds it. */
export function covers(endpoint: string, nodeId: string) {
  return endpoint === nodeId || model.nodeById.get(nodeId)?.zone === endpoint
}

/** Edges that carry a flow step. Exact node-to-node links win over zone-level ones. */
export function matchStep(step: FlowStep, visible: Edge[]): StepMatch[] {
  const exact = visible.flatMap((edge): StepMatch[] =>
    edge.source === step.from && edge.target === step.to
      ? [{ edge, reversed: false }]
      : edge.source === step.to && edge.target === step.from
        ? [{ edge, reversed: true }]
        : [],
  )
  if (exact.length) return exact
  return visible.flatMap((edge): StepMatch[] =>
    covers(edge.source, step.from) && covers(edge.target, step.to)
      ? [{ edge, reversed: false }]
      : covers(edge.source, step.to) && covers(edge.target, step.from)
        ? [{ edge, reversed: true }]
        : [],
  )
}

export const placementsOn = (nodeId: string) => model.placements.get(nodeId) ?? []

/** Edges touching a node directly or through its zone. */
export const edgesOf = (nodeId: string) =>
  model.edges.filter((e) => covers(e.source, nodeId) || covers(e.target, nodeId))

/** Databases whose every replica sits on one node. */
export const singleNodeDatabases = (app: App) => (app.databases ?? []).filter((d) => new Set(d.nodes).size === 1)

export function podPressure(n: InfraNode, usage = n.usage) {
  const pods = usage?.pods
  const max = n.hardware?.max_pods
  if (pods === undefined || !max) return undefined
  return pods / max
}

export const workers = model.nodes.filter((n) => n.kind === 'worker')

export function totals() {
  const machines = model.nodes.filter((n) => n.kind !== 'saas' && n.kind !== 'users' && n.status !== 'retired')
  const cluster = model.nodes.filter((n) => n.kind === 'worker' || n.kind === 'control-plane')
  return {
    machines: machines.length,
    clusterNodes: cluster.length,
    vcpu: cluster.reduce((s, n) => s + (n.hardware?.cpu ?? 0), 0),
    memory: cluster.reduce((s, n) => s + (n.hardware?.memory_gib ?? 0), 0),
    pods: cluster.reduce((s, n) => s + (n.usage?.pods ?? 0), 0),
    apps: apps.length,
    hostnames: apps.reduce((s, a) => s + (a.domains?.length ?? 0), 0),
    domains: model.t.domains?.list.length,
  }
}
