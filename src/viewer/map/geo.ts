import { geoEquirectangular, geoGraticule, geoPath, type GeoProjection } from 'd3-geo'
import { feature } from 'topojson-client'
import type { GeometryCollection, Topology } from 'topojson-specification'
import landTopo from 'world-atlas/land-110m.json'
import type { Site } from '../../core/types.ts'

export type Point = [number, number]

const atlas = landTopo as unknown as Topology<{ land: GeometryCollection }>
/** 1:110m coastline. The land is painted once, so finer detail would never show. */
const land = feature(atlas, atlas.objects.land)

const MIN_SPAN = { lon: 70, lat: 40 }
const PAD = { lon: 14, lat: 9 }

/**
 * West, south, east, north around the sites, padded, and never narrower than a region of the
 * world so one or two close sites still show their surroundings. No sites: the whole world.
 */
export function extentFor(sites: Site[]): [Point, Point] {
  if (!sites.length) return [[-170, -58], [180, 78]]
  const grow = (lo: number, hi: number, pad: number, min: number, floor: number, ceil: number): [number, number] => {
    let a = lo - pad
    let b = hi + pad
    if (b - a < min) {
      const mid = (a + b) / 2
      a = mid - min / 2
      b = mid + min / 2
    }
    return [Math.max(floor, a), Math.min(ceil, b)]
  }
  const [w, e] = grow(Math.min(...sites.map((s) => s.lon)), Math.max(...sites.map((s) => s.lon)), PAD.lon, MIN_SPAN.lon, -180, 180)
  const [s, n] = grow(Math.min(...sites.map((x) => x.lat)), Math.max(...sites.map((x) => x.lat)), PAD.lat, MIN_SPAN.lat, -75, 82)
  return [
    [w, s],
    [e, n],
  ]
}

export function makeProjection(width: number, height: number, [[w, s], [e, n]]: [Point, Point], pad = 28): GeoProjection {
  const corners = { type: 'MultiPoint' as const, coordinates: [[w, s], [e, n], [w, n], [e, s]] }
  return geoEquirectangular().fitExtent(
    [
      [pad, pad],
      [width - pad, height - pad],
    ],
    corners,
  )
}

/**
 * Paint the land once as a grid of small squares: rasterise the coastline into a mask, sample it
 * every `step` px, and fill a square per land sample. Zooming scales this canvas with a CSS
 * transform (GPU-composited, `image-rendering: pixelated`), so it is never redrawn while zooming.
 */
export function paintLand(canvas: HTMLCanvasElement, projection: GeoProjection, width: number, height: number, step: number, color: string) {
  const mask = document.createElement('canvas')
  mask.width = width
  mask.height = height
  const mctx = mask.getContext('2d', { willReadFrequently: true })
  const ctx = canvas.getContext('2d')
  if (!mctx || !ctx) return
  mctx.beginPath()
  geoPath(projection, mctx)(land)
  mctx.fill()
  const pixels = mctx.getImageData(0, 0, width, height).data

  // Device pixels, so squares are sharp on high-DPI screens; capped to keep the texture small.
  // Each square is snapped to whole device pixels: no anti-aliased edges for the zoom to magnify.
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  canvas.width = Math.round(width * dpr)
  canvas.height = Math.round(height * dpr)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = color
  const size = Math.max(2, Math.round(Math.max(1.4, step * 0.34) * dpr))
  for (let y = step / 2; y < height; y += step) {
    for (let x = step / 2; x < width; x += step) {
      if (pixels[(Math.floor(y) * width + Math.floor(x)) * 4 + 3] > 127) ctx.fillRect(Math.round(x * dpr), Math.round(y * dpr), size, size)
    }
  }
}

export function graticule(projection: GeoProjection, extent: [Point, Point]) {
  return geoPath(projection)(geoGraticule().extent(extent).step([10, 10])()) ?? ''
}

export interface Curve {
  d: string
  /** Point halfway along the curve, for labels. */
  mid: Point
  length: number
}

/**
 * Quadratic arc from p0 to p1. Arcs between the same two places bulge to the same side,
 * by `bend` × their distance, so several kinds between one pair fan out instead of overlapping.
 */
export function arc(p0: Point, p1: Point, bend: number, canonical: boolean): Curve {
  const [a, b] = canonical ? [p0, p1] : [p1, p0]
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = Math.hypot(dx, dy) || 1
  let nx = -dy / len
  let ny = dx / len
  // Bulge upward; for a mostly vertical arc, bulge east (over the Atlantic).
  if (Math.abs(ny) > 0.3 ? ny > 0 : nx < 0) {
    nx = -nx
    ny = -ny
  }
  const c: Point = [(a[0] + b[0]) / 2 + nx * len * bend, (a[1] + b[1]) / 2 + ny * len * bend]
  const mid: Point = [0.25 * p0[0] + 0.5 * c[0] + 0.25 * p1[0], 0.25 * p0[1] + 0.5 * c[1] + 0.25 * p1[1]]
  return { d: `M${p0[0]} ${p0[1]}Q${c[0]} ${c[1]} ${p1[0]} ${p1[1]}`, mid, length: len * (1 + bend) }
}

export interface Label {
  id: string
  anchor: Point
  x: number
  y: number
  /** Moved away from its marker far enough to need a leader line. */
  moved: boolean
}

const LABEL_GAP = 14

/**
 * Labels on the side facing away from the middle of the group (never off the right edge).
 * Markers close together share one column of labels clear of all of them, stacked top to
 * bottom, so no label covers a neighbour's marker.
 */
export function placeLabels(points: { id: string; at: Point }[], width: number, size: { w: number; h: number }): Label[] {
  const middle = points.reduce((sum, p) => sum + p.at[0], 0) / (points.length || 1)
  const out: Label[] = []
  for (const left of [true, false]) {
    const side = points
      .filter(({ at }) => (at[0] < middle || at[0] + LABEL_GAP + size.w > width) === left)
      .sort((a, b) => a.at[0] - b.at[0])
    const clusters: (typeof side)[] = []
    for (const p of side) {
      const last = clusters.at(-1)
      if (last && p.at[0] - last[last.length - 1].at[0] < size.w * 0.8) last.push(p)
      else clusters.push([p])
    }
    for (const cluster of clusters) {
      const xs = cluster.map((p) => p.at[0])
      const x = left ? Math.max(8, Math.min(...xs) - LABEL_GAP - size.w) : Math.max(...xs) + LABEL_GAP
      let floor = -Infinity
      for (const { id, at } of [...cluster].sort((a, b) => a.at[1] - b.at[1])) {
        const wanted = at[1] - size.h / 2
        const y = Math.max(wanted, floor)
        floor = y + size.h + 6
        const edge = left ? x + size.w : x
        out.push({ id, anchor: at, x, y, moved: y - wanted > 2 || Math.abs(edge - at[0]) > LABEL_GAP + 2 })
      }
    }
  }
  return out
}
