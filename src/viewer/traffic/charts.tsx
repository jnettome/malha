import { useState, type MouseEvent } from 'react'
import { fmt, fmtFull, shortDate } from './data.ts'

// Small charts for traffic: one series each, in the chart hue, so no legend; recessive axes; a
// hover readout with the exact day and value.

interface Point {
  date: string
  value: number
}

const indexAt = (e: MouseEvent<HTMLElement | SVGElement>, n: number) => {
  const r = e.currentTarget.getBoundingClientRect()
  return Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * (n - 1))))
}

const describe = (points: Point[], unit: string) => {
  if (!points.length) return `no ${unit}`
  const peak = points.reduce((a, b) => (b.value > a.value ? b : a))
  return `${unit} per day from ${shortDate(points[0].date)} to ${shortDate(points.at(-1)!.date)}; most on ${shortDate(peak.date)}, ${fmtFull(peak.value)}`
}

function paths(points: Point[], w: number, h: number, pad: number) {
  const max = Math.max(1, ...points.map((p) => p.value))
  const x = (i: number) => pad + (points.length < 2 ? (w - pad * 2) / 2 : (i * (w - pad * 2)) / (points.length - 1))
  const y = (v: number) => h - pad - (v / max) * (h - pad * 2)
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(p.value).toFixed(2)}`).join('')
  const area = points.length ? `${line}L${x(points.length - 1).toFixed(2)},${h - pad}L${x(0).toFixed(2)},${h - pad}Z` : ''
  return { line, area, x, y, max }
}

/** A row-sized trend line. */
export function Sparkline({ points, unit }: { points: Point[]; unit: string }) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 120
  const H = 30
  const { line, area, x, y } = paths(points, W, H, 2)
  const p = hover === null ? undefined : points[hover]
  return (
    <span className="spark" onMouseMove={(e) => setHover(indexAt(e, points.length))} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={describe(points, unit)}>
        <path d={area} className="chart__area" />
        <path d={line} className="chart__line" />
        {p && hover !== null && <circle cx={x(hover)} cy={y(p.value)} r="3" className="chart__dot" />}
      </svg>
      {p && (
        <span className="chart__tip" style={{ left: `${(x(hover!) / W) * 100}%` }}>
          {shortDate(p.date)} · {fmtFull(p.value)} {unit}
        </span>
      )}
    </span>
  )
}

/** A full-width daily series with a crosshair. */
export function SeriesChart({ points, unit, height = 120 }: { points: Point[]; unit: string; height?: number }) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 400
  const { line, area, x, y, max } = paths(points, W, height, 4)
  const p = hover === null ? undefined : points[hover]
  if (!points.length) return null
  return (
    <div className="chart">
      <div className="chart__plot" style={{ height }} onMouseMove={(e) => setHover(indexAt(e, points.length))} onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" role="img" aria-label={describe(points, unit)}>
          <line x1="0" x2={W} y1={y(max)} y2={y(max)} className="chart__grid" />
          <line x1="0" x2={W} y1={height - 4} y2={height - 4} className="chart__base" />
          <path d={area} className="chart__area" />
          <path d={line} className="chart__line" />
          {p && <line x1={x(hover!)} x2={x(hover!)} y1="0" y2={height} className="chart__cross" />}
        </svg>
        <span className="chart__max">{fmt(max)}</span>
        {p && (
          <>
            <i className="chart__dot-html" style={{ left: `${(x(hover!) / W) * 100}%`, top: `${(y(p.value) / height) * 100}%` }} />
            <span className="chart__tip" style={{ left: `${(x(hover!) / W) * 100}%` }}>
              {shortDate(p.date)} · {fmtFull(p.value)} {unit}
            </span>
          </>
        )}
      </div>
      <div className="chart__axis">
        <span>{shortDate(points[0].date)}</span>
        <span>{shortDate(points.at(-1)!.date)}</span>
      </div>
    </div>
  )
}

/** A ranked list: label, a bar against the first item, and the value as text. */
export function BarList({ items, unit, label }: { items: { key: string; value: number; note?: string }[]; unit: string; label: string }) {
  if (!items.length) return <p className="tbars__empty">No {label.toLowerCase()} in this period.</p>
  const max = Math.max(1, ...items.map((i) => i.value))
  return (
    <ul className="tbars" aria-label={label}>
      {items.map((i) => (
        <li key={i.key} className="tbars__row" title={`${i.key}: ${fmtFull(i.value)} ${unit}${i.note ? ` · ${i.note}` : ''}`}>
          <span className="tbars__label">
            {i.key}
            {i.note && <em>{i.note}</em>}
          </span>
          <span className="tbars__track" aria-hidden>
            <span className="tbars__fill" style={{ width: `${Math.max(1.5, (i.value / max) * 100)}%` }} />
          </span>
          <span className="tbars__value">{fmt(i.value)}</span>
        </li>
      ))}
    </ul>
  )
}
