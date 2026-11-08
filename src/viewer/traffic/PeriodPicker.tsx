import { useState } from 'react'
import { isRelative, type AnalyticsCache, type AnalyticsFile } from '../../core/analytics.ts'
import { useUi } from '../ui/state.tsx'
import { canFetchRanges, fetchRange, periodLabel } from './data.ts'

const yesterday = () => {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** The periods in the file (last 7, 30, 90 days, and fixed ranges fetched before) and, in
 *  `malha dev`, any other range: fetched by the plugins, then shown. */
export function PeriodPicker({ file, current }: { file: AnalyticsFile; current: AnalyticsCache }) {
  const ui = useUi()
  const relative = file.periods.filter((p) => isRelative(p.key)).sort((a, b) => a.days - b.days)
  const saved = file.periods.filter((p) => !isRelative(p.key))
  const [open, setOpen] = useState(false)
  const [from, setFrom] = useState(current.range.from)
  const [to, setTo] = useState(current.range.to)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const go = (period: string | undefined) => ui.openTraffic({ app: ui.traffic.app, period }, false)

  async function fetchIt() {
    const key = `${from}..${to}`
    if (file.periods.some((p) => p.key === key)) return go(key)
    setBusy(true)
    setError(undefined)
    const was = ui.traffic.period
    // The page reloads when the new period is written; this makes it open on that period.
    go(key)
    const failed = await fetchRange(from, to)
    setBusy(false)
    if (failed) {
      setError(failed)
      go(was)
    }
  }

  return (
    <div className="period">
      <div className="segmented" role="group" aria-label="Period">
        {relative.map((p) => (
          <button key={p.key} className={p.key === current.key ? 'is-active' : ''} aria-pressed={p.key === current.key} onClick={() => go(p.key)}>
            {p.days} days
          </button>
        ))}
        {canFetchRanges() && (
          <button className={open || !isRelative(current.key) ? 'is-active' : ''} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            Custom
          </button>
        )}
      </div>
      {saved.length > 0 && (
        <select className="period__saved" aria-label="Ranges fetched before" value={isRelative(current.key) ? '' : current.key} onChange={(e) => e.target.value && go(e.target.value)}>
          <option value="">Ranges fetched before</option>
          {saved.map((p) => (
            <option key={p.key} value={p.key}>
              {periodLabel(p)}, {p.range.from.slice(0, 4)}
            </option>
          ))}
        </select>
      )}
      {open && (
        <form
          className="period__custom"
          onSubmit={(e) => {
            e.preventDefault()
            void fetchIt()
          }}
        >
          <label>
            From <input type="date" value={from} max={to} min="2015-01-01" required onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            To <input type="date" value={to} min={from} max={yesterday()} required onChange={(e) => setTo(e.target.value)} />
          </label>
          <button className="btn btn--primary" disabled={busy}>
            {busy ? 'Fetching…' : 'Fetch'}
          </button>
          <span className="period__hint" role="status">
            {error ?? (busy ? 'Each plugin reads the range; answer any question it asks.' : 'Up to 366 days, ending by yesterday.')}
          </span>
        </form>
      )}
    </div>
  )
}
