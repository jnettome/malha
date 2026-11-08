import { Position } from '@xyflow/react'
import type { InfraNode, NodeKind, Zone } from '../../core/types.ts'
import type { Edge } from '../model/model.ts'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export type Side = 'top' | 'right' | 'bottom' | 'left'
export const POSITION: Record<Side, Position> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
}

export const CARD: Record<NodeKind, { w: number; h: number }> = {
  users: { w: 232, h: 96 },
  workstation: { w: 232, h: 104 },
  saas: { w: 248, h: 84 },
  server: { w: 248, h: 120 },
  proxy: { w: 288, h: 148 },
  'control-plane': { w: 288, h: 132 },
  worker: { w: 288, h: 166 },
}

const PAD = { x: 18, top: 54, bottom: 18 }
const GAP = 14
const ZONE_GAP = 40
const COL_GAP = 132
const ROW_GAP = 120
const REGION_PAD = { x: 22, top: 52, bottom: 22 }

export interface Layout {
  nodes: Map<string, Rect>
  zones: Map<string, Rect>
  /** Area that holds every member of an overlay network, e.g. the WireGuard mesh. */
  region?: Rect
  bounds: Rect
}

const union = (rects: Rect[]): Rect => {
  const x = Math.min(...rects.map((r) => r.x))
  const y = Math.min(...rects.map((r) => r.y))
  const right = Math.max(...rects.map((r) => r.x + r.w))
  const bottom = Math.max(...rects.map((r) => r.y + r.h))
  return { x, y, w: right - x, h: bottom - y }
}

export function computeLayout(zones: Zone[], nodes: InfraNode[], regionNetwork?: string): Layout {
  const members = new Map(zones.map((z) => [z.id, nodes.filter((n) => n.zone === z.id)]))
  const used = zones.filter((z) => members.get(z.id)!.length > 0)

  const inner = (z: Zone) => {
    const cards = members.get(z.id)!.map((n) => CARD[n.kind])
    return z.stack === 'horizontal'
      ? { w: cards.reduce((s, c) => s + c.w, 0) + GAP * (cards.length - 1), h: Math.max(...cards.map((c) => c.h)) }
      : { w: Math.max(...cards.map((c) => c.w)), h: cards.reduce((s, c) => s + c.h, 0) + GAP * (cards.length - 1) }
  }
  const size = new Map(used.map((z) => {
    const i = inner(z)
    return [z.id, { w: i.w + PAD.x * 2, h: i.h + PAD.top + PAD.bottom }]
  }))

  const zoneRects = new Map<string, Rect>()
  const columnX: number[] = []

  // Row 0: columns of stacked zones, vertically centered on the tallest column.
  const top = used.filter((z) => (z.row ?? 0) === 0)
  const columns = [...new Set(top.map((z) => z.column))].sort((a, b) => a - b)
  const cells = columns.map((c) => top.filter((z) => z.column === c))
  const cellW = cells.map((cell) => Math.max(...cell.map((z) => size.get(z.id)!.w)))
  const cellH = cells.map((cell) => cell.reduce((s, z) => s + size.get(z.id)!.h, 0) + ZONE_GAP * (cell.length - 1))
  const rowH = Math.max(0, ...cellH)
  let x = 0
  cells.forEach((cell, i) => {
    columnX[columns[i]] = x
    let y = (rowH - cellH[i]) / 2
    for (const z of cell) {
      const h = size.get(z.id)!.h
      zoneRects.set(z.id, { x, y, w: cellW[i], h })
      y += h + ZONE_GAP
    }
    x += cellW[i] + COL_GAP
  })

  // Later rows: zones side by side, starting at their column's x.
  let rowY = rowH + ROW_GAP
  const rows = [...new Set(used.map((z) => z.row ?? 0))].filter((r) => r > 0).sort((a, b) => a - b)
  for (const r of rows) {
    const zs = used.filter((z) => z.row === r).sort((a, b) => a.column - b.column)
    let cx = columnX[zs[0].column] ?? 0
    let tallest = 0
    for (const z of zs) {
      const s = size.get(z.id)!
      cx = Math.max(cx, columnX[z.column] ?? 0)
      zoneRects.set(z.id, { x: cx, y: rowY, ...s })
      cx += s.w + COL_GAP
      tallest = Math.max(tallest, s.h)
    }
    rowY += tallest + ROW_GAP
  }

  // Cards inside each zone, centered across the zone's width.
  const nodeRects = new Map<string, Rect>()
  for (const z of used) {
    const zr = zoneRects.get(z.id)!
    const i = inner(z)
    let cx = zr.x + (zr.w - i.w) / 2
    let cy = zr.y + PAD.top
    for (const n of members.get(z.id)!) {
      const c = CARD[n.kind]
      if (z.stack === 'horizontal') {
        nodeRects.set(n.id, { x: cx, y: cy, ...c })
        cx += c.w + GAP
      } else {
        nodeRects.set(n.id, { x: zr.x + (zr.w - c.w) / 2, y: cy, ...c })
        cy += c.h + GAP
      }
    }
  }

  let region: Rect | undefined
  if (regionNetwork) {
    // Whole zones when every card in them is a member, otherwise just the member cards.
    const rects = used.flatMap((z) => {
      const ms = members.get(z.id)!
      const inNet = ms.filter((n) => n.networks?.includes(regionNetwork))
      if (!inNet.length) return []
      return inNet.length === ms.length ? [zoneRects.get(z.id)!] : inNet.map((n) => nodeRects.get(n.id)!)
    })
    if (rects.length) {
      const u = union(rects)
      region = { x: u.x - REGION_PAD.x, y: u.y - REGION_PAD.top, w: u.w + REGION_PAD.x * 2, h: u.h + REGION_PAD.top + REGION_PAD.bottom }
    }
  }

  const all = [...zoneRects.values(), ...(region ? [region] : [])]
  return { nodes: nodeRects, zones: zoneRects, region, bounds: union(all) }
}

/** Which side of each card an edge leaves from and arrives at. */
export function chooseSides(edge: Pick<Edge, 'source' | 'target' | 'kind'>, s: Rect, t: Rect, rowOf: (id: string) => number): [Side, Side] {
  const rs = rowOf(edge.source)
  const rt = rowOf(edge.target)
  if (rs !== rt) return rs < rt ? ['bottom', 'top'] : ['top', 'bottom']

  const overlapX = s.x < t.x + t.w && t.x < s.x + s.w
  if (overlapX) {
    // Same column: bracket out to one side. Control traffic takes the left, everything else the right.
    const side: Side = edge.kind === 'control' ? 'left' : 'right'
    return [side, side]
  }
  return t.x > s.x ? ['right', 'left'] : ['left', 'right']
}
