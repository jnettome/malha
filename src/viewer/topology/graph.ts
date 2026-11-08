import type { Edge as RFEdge, Node as RFNode } from '@xyflow/react'
import { covers, flows, matchStep, model, networks, zones, type Edge } from '../model/model.ts'
import type { App, InfraNode, LinkKind } from '../../core/types.ts'
import type { Selection } from '../ui/state.tsx'
import type { EdgeEmphasis, FlowEdgeType } from './FlowEdge.tsx'
import { chooseSides, computeLayout, type Layout } from './layout.ts'
import type { Badge, Emphasis, InfraFlowNode, RegionFlowNode, ZoneFlowNode } from './nodes.tsx'

export const REGION_NETWORK = networks.find(
  (net) => net.kind === 'overlay' && model.nodes.some((n) => n.networks?.includes(net.id)),
)

const REGION_ID = '__region'

export function layoutFor(showRetired: boolean) {
  const visible = model.nodes.filter((n) => showRetired || n.status !== 'retired')
  return { visible, layout: computeLayout(zones, visible, REGION_NETWORK?.id) }
}

interface EdgeState {
  emphasis: EdgeEmphasis
  reversed?: boolean
  label?: string
}

interface Hop {
  id: string
  source: string
  target: string
  kind: LinkKind
  label: string
}

/** What is highlighted, and how. `null` means nothing is: everything draws normally. */
interface Focus {
  nodes: Set<string>
  selected?: string
  edges: Map<string, EdgeState>
  hops: Hop[]
  badges: Map<string, Badge>
}

// The way in (DNS, HTTP) is shared by every public app; anything else must reach a node the app uses.
const ENTRY = new Set<LinkKind>(['http', 'dns'])

const touches = (endpoint: string, set: Set<string>) =>
  set.has(endpoint) || (model.zoneMembers.get(endpoint)?.some((id) => set.has(id)) ?? false)

function flowFocus(flowId: string, current: number, edges: Edge[]): Focus | null {
  const flow = flows.find((f) => f.id === flowId)
  if (!flow) return null
  const focus: Focus = { nodes: new Set(), edges: new Map(), hops: [], badges: new Map() }
  flow.steps.forEach((step, i) => {
    focus.nodes.add(step.from).add(step.to)
    const active = i === current
    const matches = step.via ? [] : matchStep(step, edges)
    if (!matches.length) {
      focus.hops.push({ id: `hop:${flow.id}:${i}`, source: step.from, target: step.to, kind: flow.kind, label: step.label })
      return
    }
    for (const { edge, reversed } of matches) {
      const prev = focus.edges.get(edge.id)
      if (active) focus.edges.set(edge.id, { emphasis: 'active', reversed, label: step.label })
      else if (!prev) focus.edges.set(edge.id, { emphasis: 'lit', reversed })
    }
  })
  return focus
}

const memberIds = (endpoint: string) => model.zoneMembers.get(endpoint) ?? [endpoint]

/**
 * How visitors reach an app with public domains: walk HTTP links backwards from where it runs
 * (load balancers, then the users in front of them), then add the DNS those users resolve with.
 */
function entryPath(where: Set<string>, edges: Edge[]) {
  const found = new Set<string>()
  let frontier = new Set(where)
  for (let hop = 0; hop < 4 && frontier.size; hop++) {
    const next = new Set<string>()
    for (const e of edges) {
      if (e.kind !== 'http' || !touches(e.target, frontier)) continue
      for (const id of memberIds(e.source)) if (!found.has(id) && !where.has(id)) next.add(id)
    }
    for (const id of next) found.add(id)
    frontier = next
  }
  for (const e of edges) if (e.kind === 'dns' && touches(e.source, found)) for (const id of memberIds(e.target)) found.add(id)
  return found
}

function appFocus(app: App, edges: Edge[]): Focus {
  const nodes = new Set<string>()
  const badges = new Map<string, Badge>()
  const badge = (id: string) => {
    const b = badges.get(id) ?? { pods: 0, databases: [], uses: false }
    badges.set(id, b)
    return b
  }
  for (const [id, pods] of Object.entries(app.pods ?? {})) {
    nodes.add(id)
    badge(id).pods = pods
  }
  for (const db of app.databases ?? []) for (const id of db.nodes) {
    nodes.add(id)
    badge(id).databases.push(db.name)
  }
  if (app.host) nodes.add(app.host)
  for (const id of app.uses ?? []) {
    nodes.add(id)
    badge(id).uses = true
  }
  if (app.domains?.length) for (const id of entryPath(nodes, edges)) nodes.add(id)
  const uses = new Set(app.uses)
  const focus: Focus = { nodes, edges: new Map(), hops: [], badges }
  for (const e of edges) {
    const own = ENTRY.has(e.kind) || uses.has(e.source) || uses.has(e.target)
    if (own && touches(e.source, nodes) && touches(e.target, nodes)) focus.edges.set(e.id, { emphasis: 'lit' })
  }
  return focus
}

function nodeFocus(id: string, edges: Edge[]): Focus {
  const nodes = new Set([id])
  const focus: Focus = { nodes, selected: id, edges: new Map(), hops: [], badges: new Map() }
  for (const e of edges) {
    const out = covers(e.source, id)
    const into = covers(e.target, id)
    if (!out && !into) continue
    focus.edges.set(e.id, { emphasis: 'lit' })
    const other = out ? e.target : e.source
    for (const m of model.zoneMembers.get(other) ?? [other]) nodes.add(m)
  }
  return focus
}

export interface GraphInput {
  layout: Layout
  visible: InfraNode[]
  hidden: Set<LinkKind>
  selection: Selection | null
  flow: { id: string; step: number } | null
  hoveredEdge: string | null
  motion: boolean
}

export function buildGraph({ layout, visible, hidden, selection, flow, hoveredEdge, motion }: GraphInput) {
  const shown = new Set([...visible.map((n) => n.id), ...layout.zones.keys()])
  const present = model.edges.filter((e) => shown.has(e.source) && shown.has(e.target))

  const focus = flow
    ? flowFocus(flow.id, flow.step, present)
    : selection?.type === 'app'
      ? appFocus(model.appById.get(selection.id)!, present)
      : selection?.type === 'node'
        ? nodeFocus(selection.id, present)
        : null

  // A layer toggle hides an edge unless the running flow needs it.
  const drawn = present.filter((e) => !hidden.has(e.kind) || (flow && focus?.edges.has(e.id)))

  const rowOf = (id: string) => model.zoneById.get(model.nodeById.get(id)?.zone ?? id)?.row ?? 0
  const rect = (id: string) => layout.nodes.get(id) ?? layout.zones.get(id)!

  const nodeEmphasis = (id: string): Emphasis =>
    !focus ? 'normal' : focus.selected === id ? 'selected' : focus.nodes.has(id) ? 'lit' : 'dim'

  const rfNodes: RFNode[] = []
  if (layout.region && REGION_NETWORK) {
    const r = layout.region
    const members = model.nodes.filter((n) => n.networks?.includes(REGION_NETWORK.id))
    rfNodes.push({
      id: REGION_ID,
      type: 'region',
      position: { x: r.x, y: r.y },
      width: r.w,
      height: r.h,
      zIndex: -2,
      selectable: false,
      draggable: false,
      data: {
        label: `${REGION_NETWORK.id} · ${REGION_NETWORK.name}`,
        detail: [REGION_NETWORK.cidr, REGION_NETWORK.port && `udp ${REGION_NETWORK.port}`, `${members.length} peers`].filter(Boolean).join(' · '),
        dim: Boolean(focus) && !members.some((m) => focus!.nodes.has(m.id)),
      },
    } satisfies RegionFlowNode)
  }
  zones.forEach((zone, index) => {
    const r = layout.zones.get(zone.id)
    if (!r) return
    const dim = Boolean(focus) && !(model.zoneMembers.get(zone.id) ?? []).some((id) => focus!.nodes.has(id))
    rfNodes.push({
      id: zone.id,
      type: 'zone',
      position: { x: r.x, y: r.y },
      width: r.w,
      height: r.h,
      zIndex: -1,
      selectable: false,
      draggable: false,
      data: { zone, index, dim },
    } satisfies ZoneFlowNode)
  })
  for (const n of visible) {
    const r = layout.nodes.get(n.id)!
    rfNodes.push({
      id: n.id,
      type: 'infra',
      position: { x: r.x, y: r.y },
      width: r.w,
      height: r.h,
      zIndex: 10,
      draggable: false,
      data: { node: n, emphasis: nodeEmphasis(n.id), badge: focus?.badges.get(n.id) },
    } satisfies InfraFlowNode)
  }

  const Z: Record<EdgeEmphasis, number> = { dim: 1, normal: 2, lit: 3, active: 4 }
  const rfEdges: RFEdge[] = []
  const pushEdge = (
    id: string,
    source: string,
    target: string,
    kind: LinkKind,
    state: EdgeState,
    extra: { label?: string; ports?: number[]; hop?: boolean },
  ) => {
    const [s, t] = chooseSides({ source, target, kind }, rect(source), rect(target), rowOf)
    rfEdges.push({
      id,
      type: 'flow',
      source,
      target,
      sourceHandle: `${s}-s`,
      targetHandle: `${t}-t`,
      zIndex: Z[state.emphasis],
      data: { kind, emphasis: state.emphasis, reversed: state.reversed, hovered: hoveredEdge === id, motion, ...extra },
    } satisfies FlowEdgeType)
  }

  for (const e of drawn) {
    const state = focus?.edges.get(e.id) ?? { emphasis: focus ? 'dim' : 'normal' }
    pushEdge(e.id, e.source, e.target, e.kind, state, { label: state.label ?? e.link.label, ports: e.link.ports })
  }
  flow &&
    focus?.hops.forEach((h) => {
      if (!shown.has(h.source) || !shown.has(h.target)) return
      const active = h.id === `hop:${flow.id}:${flow.step}`
      pushEdge(h.id, h.source, h.target, h.kind, { emphasis: active ? 'active' : 'lit' }, { label: h.label, hop: true })
    })

  return { rfNodes, rfEdges, involved: focus ? [...focus.nodes].filter((id) => shown.has(id)) : [] }
}
