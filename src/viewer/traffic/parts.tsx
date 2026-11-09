import { delta, fmt, fmtFull } from './data.ts'

export function Delta({ now, before, warn = true }: { now?: number; before?: number; warn?: boolean }) {
  const d = delta(now, before)
  if (d.value === undefined) return <span className="delta">—</span>
  const up = d.value >= 0
  const flagged = warn && d.warn
  return (
    <span className={`delta${flagged ? ' delta--warn' : ''}`} title={`${fmtFull(now)} against ${fmtFull(before)} the period before`}>
      {flagged ? '⚠ ' : ''}
      {up ? '▲' : '▼'} {Math.abs(Math.round(d.value * 100))}%
    </span>
  )
}

/** A number with its change from the previous period, or `note` in place of the change. */
export function Tile({ label, now, before, shown, warn, note }: { label: string; now?: number; before?: number; shown?: string; warn?: boolean; note?: string }) {
  return (
    <div className="tile">
      <span className="tile__label">{label}</span>
      <span className="tile__value">{shown ?? fmt(now)}</span>
      {note !== undefined ? <span className="delta">{note}</span> : <Delta now={now} before={before} warn={warn} />}
    </div>
  )
}
