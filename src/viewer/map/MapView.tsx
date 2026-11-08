import { select } from 'd3-selection'
import 'd3-transition'
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from 'd3-zoom'
import { motion } from 'motion/react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { InfraNode, Site } from '../../core/types.ts'
import { LayerToggle } from '../topology/Rail.tsx'
import { FAMILIES, KIND_ORDER, KINDS } from '../ui/kinds.ts'
import { Packets } from '../ui/Packets.tsx'
import { KindSwatch, Led } from '../ui/parts.tsx'
import { usePrefersReducedMotion, useUi } from '../ui/state.tsx'
import { arc, extentFor, graticule, makeProjection, paintLand, placeLabels, type Curve, type Point } from './geo.ts'
import { INSET, MetroInset } from './MetroInset.tsx'
import { arcs, datacenters, sites, unplaced, type SiteArc } from './sites.ts'

const DOT_STEP = 7
const LABEL = { w: 168, h: 40 }
const INSET_MARGIN = 20
const MIN_WIDTH_FOR_INSET = 980
const MIN_WIDTH_FOR_LABELS = 560
// The land is a fixed texture that scales with the zoom; past this its squares get coarse.
const MAX_ZOOM = 10
const SITE_ZOOM = 7

export function useSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width)
      const h = Math.round(entry.contentRect.height)
      setSize((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return size
}

const isMachine = (n: InfraNode) => n.kind !== 'saas' && n.kind !== 'users'

function siteSummary(site: Site) {
  const nodes = datacenters(site.id).flatMap((dc) => dc.nodes)
  const machines = nodes.filter(isMachine).length
  const services = nodes.length - machines
  return {
    machines,
    text: [machines && `${machines} machine${machines > 1 ? 's' : ''}`, services && `${services} service${services > 1 ? 's' : ''}`].filter(Boolean).join(' · '),
  }
}

// The site shown up close: the one with the most datacenters, if it has several.
const metro = sites
  .map((s) => ({ s, n: datacenters(s.id).length }))
  .filter((x) => x.n >= 3)
  .sort((a, b) => b.n - a.n)[0]?.s

/**
 * Everything on the map is drawn once, in projected coordinates, and zooming never re-renders it.
 * The land is a canvas moved by a CSS transform; arcs, markers and the graticule sit in one SVG
 * group whose transform is set directly from the d3-zoom handler. Lines keep their width with
 * non-scaling-stroke, markers and packets keep their size with a CSS scale of 1/k. Only the
 * floating labels and leader lines are re-placed per frame, by hand, outside React.
 */
export function MapView() {
  const ui = useUi()
  const reduced = usePrefersReducedMotion()
  const stage = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const worldRef = useRef<SVGGElement>(null)
  const zoomTextRef = useRef<HTMLSpanElement>(null)
  const insetLeaderRef = useRef<SVGPathElement>(null)
  const labelRefs = useRef(new Map<string, HTMLButtonElement>())
  const leaderRefs = useRef(new Map<string, SVGLineElement>())
  const behavior = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null)
  const zoomRef = useRef<ZoomTransform>(zoomIdentity)
  const size = useSize(stage)
  const [focus, setFocus] = useState<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [insetOpen, setInsetOpen] = useState(true)

  const extent = useMemo(() => extentFor(sites), [])
  const base = useMemo(() => (size && size.w > 50 && size.h > 50 ? makeProjection(size.w, size.h, extent) : null), [size, extent])
  const at = useMemo(() => (base ? new Map(sites.map((s) => [s.id, base([s.lon, s.lat]) as Point])) : null), [base])
  const grid = useMemo(() => (base ? graticule(base, extent) : ''), [base, extent])
  const showLabels = Boolean(size && size.w >= MIN_WIDTH_FOR_LABELS)
  const showInset = Boolean(metro && size && size.w >= MIN_WIDTH_FOR_INSET)

  const curves = useMemo(() => {
    const out = new Map<string, Curve>()
    if (!at) return out
    // Every arc between the same two sites gets its own bend so they fan out.
    const byPair = new Map<string, SiteArc[]>()
    for (const a of arcs) {
      const key = [a.from, a.to].sort().join('|')
      byPair.set(key, [...(byPair.get(key) ?? []), a])
    }
    for (const group of byPair.values()) {
      group.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.from.localeCompare(b.from))
      group.forEach((a, i) => out.set(a.id, arc(at.get(a.from)!, at.get(a.to)!, 0.14 + i * 0.07, a.from < a.to)))
    }
    return out
  }, [at])

  // The land: painted once per size, then only ever moved by the zoom transform.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !base || !size) return
    paintLand(canvas, base, size.w, size.h, DOT_STEP, getComputedStyle(canvas).color)
  }, [base, size])

  // Applies the current zoom to the DOM directly. Kept in a ref so d3 always calls the latest one.
  const apply = useRef(() => {})
  apply.current = () => {
    const t = zoomRef.current
    if (canvasRef.current) canvasRef.current.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.k})`
    worldRef.current?.setAttribute('transform', `translate(${t.x} ${t.y}) scale(${t.k})`)
    svgRef.current?.style.setProperty('--k', String(t.k))
    if (zoomTextRef.current) zoomTextRef.current.textContent = `${t.k.toFixed(1)}×`
    if (!at || !size) return
    const screen = (id: string) => t.apply(at.get(id)!) as Point
    if (showLabels) {
      for (const l of placeLabels(sites.map((s) => ({ id: s.id, at: screen(s.id) })), size.w, LABEL)) {
        const label = labelRefs.current.get(l.id)
        if (label) label.style.transform = `translate(${l.x}px, ${l.y}px)`
        const line = leaderRefs.current.get(l.id)
        if (!line) continue
        line.style.display = l.moved ? '' : 'none'
        line.setAttribute('x1', String(l.anchor[0]))
        line.setAttribute('y1', String(l.anchor[1]))
        line.setAttribute('x2', String(l.x < l.anchor[0] ? l.x + LABEL.w : l.x))
        line.setAttribute('y2', String(l.y + LABEL.h / 2))
      }
    }
    if (insetLeaderRef.current && metro && size) {
      const [x, y] = screen(metro.id)
      insetLeaderRef.current.setAttribute('d', `M${x} ${y}L${size.w - INSET_MARGIN - INSET.w} ${size.h - INSET_MARGIN - INSET.h + INSET.head / 2}`)
    }
  }
  // After every render, so freshly mounted labels and leaders get their positions before paint.
  useLayoutEffect(() => apply.current())

  useEffect(() => {
    const svg = svgRef.current
    const stageEl = stage.current
    if (!svg || !stageEl || !size || !base) return
    const z = zoom<SVGSVGElement, unknown>()
      .scaleExtent([1, MAX_ZOOM])
      .extent([
        [0, 0],
        [size.w, size.h],
      ])
      .translateExtent([
        [0, 0],
        [size.w, size.h],
      ])
      .clickDistance(4)
      .on('start', () => stageEl.classList.add('is-zooming'))
      .on('zoom', (e) => {
        zoomRef.current = e.transform
        apply.current()
      })
      .on('end', () => stageEl.classList.remove('is-zooming'))
    const selection = select(svg)
    // Double-click flies to a site instead (handled on the markers), so d3's own dblclick zoom is off.
    selection.call(z).call(z.transform, zoomIdentity).on('dblclick.zoom', null)
    behavior.current = z
    return () => {
      selection.on('.zoom', null)
    }
  }, [size, base])

  const animateTo = (target: ZoomTransform) => {
    if (!svgRef.current || !behavior.current) return
    select(svgRef.current).transition().duration(reduced ? 0 : 650).call(behavior.current.transform, target)
  }
  const zoomBy = (factor: number) => {
    if (!svgRef.current || !behavior.current) return
    select(svgRef.current).transition().duration(reduced ? 0 : 300).call(behavior.current.scaleBy, factor)
  }
  const zoomToSite = (s: Site) => {
    if (!at || !size) return
    const [x, y] = at.get(s.id)!
    animateTo(zoomIdentity.translate(size.w / 2, size.h / 2).scale(SITE_ZOOM).translate(-x, -y))
    setFocus(s.id)
  }

  const visible = arcs.filter((a) => !ui.hidden.has(a.kind))
  const touches = (a: SiteArc) => !focus || a.from === focus || a.to === focus
  const hovered = visible.find((a) => a.id === hover)
  const tipAt = hovered && curves.get(hovered.id) ? (zoomRef.current.apply(curves.get(hovered.id)!.mid) as Point) : null

  return (
    <div className="mapview">
      <div className="mapview__stage" ref={stage} onClick={() => setFocus(null)}>
        {size && <canvas ref={canvasRef} className="map__land" style={{ width: size.w, height: size.h }} aria-hidden />}
        {base && size && at && (
          <svg ref={svgRef} className="map" width={size.w} height={size.h} role="img" aria-label="Sites and the traffic between them">
            <g ref={worldRef} className="map__world">
              <path className="map__grid" d={grid} vectorEffect="non-scaling-stroke" />
              {visible.map((a) => {
                const c = curves.get(a.id)
                if (!c) return null
                const k = KINDS[a.kind]
                const family = FAMILIES[k.family]
                const lit = (hover === a.id || (focus !== null && touches(a))) && !(hover && hover !== a.id)
                const dim = (focus !== null && !touches(a)) || (hover !== null && hover !== a.id)
                return (
                  <g
                    key={a.id}
                    className={`map__arc${dim ? ' is-dim' : ''}${lit ? ' is-lit' : ''}`}
                    onMouseEnter={() => setHover(a.id)}
                    onMouseLeave={() => setHover(null)}
                  >
                    <path d={c.d} className="map__arc-hit" vectorEffect="non-scaling-stroke" />
                    <path d={c.d} className="map__arc-line" stroke={family.line} strokeDasharray={k.dash} vectorEffect="non-scaling-stroke" />
                    {!reduced && !dim && (
                      <Packets path={c.d} duration={Math.max(1.6, c.length / (k.speed * 1.4))} count={lit ? 3 : 2} color={family.packet} large={lit} />
                    )}
                  </g>
                )
              })}
              {sites.map((s, i) => {
                const [x, y] = at.get(s.id)!
                const { machines } = siteSummary(s)
                const r = machines ? 3.5 + Math.sqrt(machines) * 1.2 : 3.5
                const dim = focus !== null && focus !== s.id && !visible.some((a) => touches(a) && (a.from === s.id || a.to === s.id))
                return (
                  <g
                    key={s.id}
                    className={`map__site${machines ? ' map__site--ours' : ''}${dim ? ' is-dim' : ''}${focus === s.id ? ' is-focus' : ''}`}
                    transform={`translate(${x} ${y})`}
                    onClick={(e) => {
                      e.stopPropagation()
                      setFocus(focus === s.id ? null : s.id)
                    }}
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      zoomToSite(s)
                    }}
                  >
                    <g className="map__site-body">
                      <circle r={r + 8} className="map__site-pulse" style={{ animationDelay: `${i * 0.35}s` }} />
                      <circle r={r} className="map__site-dot" />
                    </g>
                  </g>
                )
              })}
            </g>
            {/* Screen space: positioned per frame by apply(). */}
            {showInset && insetOpen && <path ref={insetLeaderRef} className="map__leader" />}
            {showLabels &&
              sites.map((s) => (
                <line
                  key={s.id}
                  ref={(el) => {
                    if (el) leaderRefs.current.set(s.id, el)
                    else leaderRefs.current.delete(s.id)
                  }}
                  className="map__label-leader"
                  style={{ display: 'none' }}
                />
              ))}
          </svg>
        )}

        {showLabels &&
          sites.map((s) => {
            const dim = focus !== null && focus !== s.id
            return (
              <button
                key={s.id}
                ref={(el) => {
                  if (el) labelRefs.current.set(s.id, el)
                  else labelRefs.current.delete(s.id)
                }}
                className={`map__label${dim ? ' is-dim' : ''}${focus === s.id ? ' is-focus' : ''}`}
                style={{ width: LABEL.w }}
                onClick={(e) => {
                  e.stopPropagation()
                  setFocus(focus === s.id ? null : s.id)
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  zoomToSite(s)
                }}
              >
                <span className="map__label-name">{s.name}</span>
                <span className="map__label-meta">{siteSummary(s).text || s.region}</span>
              </button>
            )
          })}

        {hovered && tipAt && (
          <div className="map__tip" style={{ left: tipAt[0], top: tipAt[1] }}>
            <span className="edge-label__kind">
              <KindSwatch kind={hovered.kind} width={18} />
              {KINDS[hovered.kind].label}
            </span>
            <span className="map__tip-route">
              {sites.find((s) => s.id === hovered.from)?.name} → {sites.find((s) => s.id === hovered.to)?.name}
            </span>
            {hovered.labels.join(' · ')}
            <span className="metro__tip-hops">
              {hovered.hops.slice(0, 3).join(', ') + (hovered.hops.length > 3 ? ` +${hovered.hops.length - 3}` : '')}
            </span>
          </div>
        )}

        <div className="map__controls" onClick={(e) => e.stopPropagation()}>
          <button onClick={() => zoomBy(1.6)} aria-label="Zoom in">
            +
          </button>
          <button onClick={() => zoomBy(1 / 1.6)} aria-label="Zoom out">
            −
          </button>
          <button onClick={() => animateTo(zoomIdentity)} aria-label="Show everything" title="Show everything">
            ⤢
          </button>
          <span ref={zoomTextRef} className="map__zoom">
            1.0×
          </span>
        </div>

        {showInset && metro && insetOpen && (
          <div className="mapview__inset" style={{ right: INSET_MARGIN, bottom: INSET_MARGIN }} onClick={(e) => e.stopPropagation()}>
            <MetroInset site={metro} />
            <button className="btn btn--ghost metro__close" onClick={() => setInsetOpen(false)}>
              Hide
            </button>
          </div>
        )}
        {showInset && metro && !insetOpen && (
          <button
            className="btn inset-toggle"
            onClick={(e) => {
              e.stopPropagation()
              setInsetOpen(true)
            }}
          >
            {metro.name} up close
          </button>
        )}
      </div>

      <SidePanel focus={focus} setFocus={setFocus} zoomToSite={zoomToSite} inset={!showInset && metro ? <FitWidth width={INSET.w} height={INSET.h}><MetroInset site={metro} /></FitWidth> : null} />
    </div>
  )
}

/** Scales fixed-size content down to the width it is given. */
function FitWidth({ width, height, children }: { width: number; height: number; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const size = useSize(box)
  const scale = size ? Math.min(1, size.w / width) : 1
  return (
    <div ref={box} className="fit" style={{ height: height * scale }}>
      <div style={{ width, transform: `scale(${scale})`, transformOrigin: 'top left' }}>{children}</div>
    </div>
  )
}

function NodeChip({ n }: { n: InfraNode }) {
  const ui = useUi()
  return (
    <button className="chip-btn" onClick={() => ui.select({ type: 'node', id: n.id })}>
      <Led status={n.status} />
      {n.name}
    </button>
  )
}

function SidePanel({
  focus,
  setFocus,
  zoomToSite,
  inset,
}: {
  focus: string | null
  setFocus: (id: string | null) => void
  zoomToSite: (s: Site) => void
  inset: ReactNode
}) {
  const kinds = KIND_ORDER.filter((k) => arcs.some((a) => a.kind === k))
  const everywhere = unplaced.filter((n) => n.kind === 'saas' || n.kind === 'users')
  const unknown = unplaced.filter((n) => n.kind !== 'saas' && n.kind !== 'users')
  const ordered = [...sites].sort((a, b) => siteSummary(b).machines - siteSummary(a).machines)

  return (
    <aside className="mapview__side">
      {inset && <section>{inset}</section>}
      <section>
        <h2 className="eyebrow">Sites</h2>
        <p className="side-note">Drag to pan, scroll or pinch to zoom, double-click a site to fly to it.</p>
        {ordered.map((s) => {
          const open = focus === s.id
          return (
            <div key={s.id} className={`site${open ? ' is-open' : ''}`}>
              <button className="site__head" onClick={() => setFocus(open ? null : s.id)}>
                <span className="site__name">{s.name}</span>
                <span className="site__region">{s.region}</span>
                <span className="site__count">{siteSummary(s).text}</span>
              </button>
              {open && (
                <motion.div className="site__body" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}>
                  {datacenters(s.id).map((dc) => (
                    <div key={dc.id} className="site__dc">
                      <span className="site__dc-name">{dc.name}</span>
                      <div className="site__chips">
                        {dc.nodes.map((n) => (
                          <NodeChip key={n.id} n={n} />
                        ))}
                      </div>
                    </div>
                  ))}
                  {s.notes && <p className="site__notes">{Array.isArray(s.notes) ? s.notes.join(' ') : s.notes}</p>}
                  <div className="site__foot">
                    <span className="site__coords">
                      {Math.abs(s.lat).toFixed(2)}°{s.lat < 0 ? 'S' : 'N'} {Math.abs(s.lon).toFixed(2)}°{s.lon < 0 ? 'W' : 'E'}
                    </span>
                    <button className="btn" onClick={() => zoomToSite(s)}>
                      Zoom here
                    </button>
                  </div>
                </motion.div>
              )}
            </div>
          )
        })}
      </section>

      {everywhere.length > 0 && (
        <section>
          <h2 className="eyebrow">Everywhere</h2>
          <p className="side-note">Anycast or global, so no pin.</p>
          <div className="site__chips">
            {everywhere.map((n) => (
              <NodeChip key={n.id} n={n} />
            ))}
          </div>
        </section>
      )}

      {unknown.length > 0 && (
        <section>
          <h2 className="eyebrow">Not placed</h2>
          <p className="side-note">
            No <code>site</code> in topology.yaml yet.
          </p>
          <div className="site__chips">
            {unknown.map((n) => (
              <NodeChip key={n.id} n={n} />
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="eyebrow">Layers</h2>
        {kinds.map((k) => (
          <LayerToggle key={k} kind={k} />
        ))}
        <p className="side-note">Shared with the Topology view. Hover an arc for what it carries.</p>
      </section>
    </aside>
  )
}

