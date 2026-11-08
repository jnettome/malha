import { motion } from 'motion/react'
import { useMemo, useState } from 'react'
import type { Site } from '../../core/types.ts'
import { REGION_NETWORK } from '../topology/graph.ts'
import { FAMILIES, KINDS } from '../ui/kinds.ts'
import { Packets } from '../ui/Packets.tsx'
import { KindSwatch, Led } from '../ui/parts.tsx'
import { usePrefersReducedMotion, useUi } from '../ui/state.tsx'
import { datacenters, dcLinks, meshPeers, type DcLink } from './sites.ts'

export const INSET = { w: 480, h: 340, head: 44 }
const BOX_W = 132
const LANE = 5

/** One site up close: its datacenters around an ellipse and the traffic between them. */
export function MetroInset({ site }: { site: Site }) {
  const ui = useUi()
  const reduced = usePrefersReducedMotion()
  const [hover, setHover] = useState<string | null>(null)
  const dcs = useMemo(() => datacenters(site.id), [site.id])
  const peers = useMemo(() => new Set(REGION_NETWORK ? meshPeers(site.id, REGION_NETWORK.id) : []), [site.id])

  const area = { w: INSET.w, h: INSET.h - INSET.head }
  const centers = new Map(
    dcs.map((dc, i) => {
      const angle = -Math.PI / 2 + (i / dcs.length) * Math.PI * 2
      return [dc.id, [area.w / 2 + Math.cos(angle) * (area.w / 2 - BOX_W / 2 - 10), area.h / 2 + Math.sin(angle) * (area.h / 2 - 34)] as const]
    }),
  )

  const links = dcLinks.filter((l) => l.site === site.id && !ui.hidden.has(l.kind))
  // Kinds sharing a pair of datacenters run in parallel lanes.
  const lanes = new Map<string, DcLink[]>()
  for (const l of links) {
    const key = [l.from, l.to].sort().join('|')
    lanes.set(key, [...(lanes.get(key) ?? []), l])
  }
  const machines = dcs.reduce((n, dc) => n + dc.nodes.filter((x) => x.kind !== 'saas').length, 0)
  const hovered = links.find((l) => l.id === hover)

  return (
    <motion.section
      className="metro"
      style={{ width: INSET.w, height: INSET.h }}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.25, duration: 0.4 }}
    >
      <header className="metro__head">
        <span className="eyebrow eyebrow--accent">{site.name} up close</span>
        <span className="metro__sub">
          {dcs.length} datacenters · {machines} machines{peers.size > 1 ? ` · ${REGION_NETWORK?.id} mesh between ${peers.size}` : ''}
        </span>
      </header>
      <svg className="metro__lines" width={area.w} height={area.h} style={{ top: INSET.head }}>
        {[...peers].flatMap((a, i, list) =>
          list.slice(i + 1).map((b) => {
            const [p, q] = [centers.get(a)!, centers.get(b)!]
            return <line key={`${a}-${b}`} className="metro__mesh" x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} />
          }),
        )}
        {[...lanes.values()].flatMap((group) =>
          group.map((l, i) => {
            const [p, q] = [centers.get(l.from)!, centers.get(l.to)!]
            const dx = q[0] - p[0]
            const dy = q[1] - p[1]
            const len = Math.hypot(dx, dy) || 1
            // Offset from the sorted pair's direction so both directions share one set of lanes.
            const sign = l.from < l.to ? 1 : -1
            const off = (i - (group.length - 1) / 2) * LANE * sign
            const ox = (-dy / len) * off
            const oy = (dx / len) * off
            const d = `M${p[0] + ox} ${p[1] + oy}L${q[0] + ox} ${q[1] + oy}`
            const k = KINDS[l.kind]
            const family = FAMILIES[k.family]
            const dim = hover !== null && hover !== l.id
            return (
              <g key={l.id} className={`metro__link${dim ? ' is-dim' : ''}`} onMouseEnter={() => setHover(l.id)} onMouseLeave={() => setHover(null)}>
                <path d={d} className="metro__hit" />
                <path d={d} className="metro__line" stroke={family.line} strokeDasharray={k.dash} />
                {!reduced && !dim && <Packets path={d} duration={Math.max(1, len / k.speed)} count={1} color={family.packet} />}
              </g>
            )
          }),
        )}
      </svg>
      {dcs.map((dc) => {
        const [x, y] = centers.get(dc.id)!
        return (
          <div key={dc.id} className={`metro__dc${peers.has(dc.id) ? ' is-peer' : ''}`} style={{ left: x - BOX_W / 2, top: INSET.head + y, width: BOX_W }}>
            <span className="metro__dc-name">{dc.name}</span>
            {dc.nodes.map((n) => (
              <button key={n.id} className="metro__node" onClick={() => ui.select({ type: 'node', id: n.id })}>
                <Led status={n.status} />
                {n.name}
              </button>
            ))}
          </div>
        )
      })}
      {hovered && (
        <div className="metro__tip">
          <span className="edge-label__kind">
            <KindSwatch kind={hovered.kind} width={18} />
            {KINDS[hovered.kind].label}
          </span>
          {hovered.labels.join(' · ')}
          <span className="metro__tip-hops">{hovered.hops.slice(0, 4).join(', ') + (hovered.hops.length > 4 ? ` +${hovered.hops.length - 4}` : '')}</span>
        </div>
      )}
    </motion.section>
  )
}
