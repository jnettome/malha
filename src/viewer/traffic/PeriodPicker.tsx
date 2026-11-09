import { useEffect, useRef, useState } from 'react'
import { isRelative, type AnalyticsCache, type AnalyticsFile, type DateRange } from '../../core/analytics.ts'
import { useUi } from '../ui/state.tsx'
import { daysBetween, RangeCalendar, shortcuts } from './Calendar.tsx'
import { canFetchRanges, fetchRange, periodLabel, shortDate } from './data.ts'

const MAX_DAYS = 366
const yesterday = () => {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** The periods in the file (last 7, 30, 90 days, and ranges fetched before) and, in `malha dev`, a
 *  calendar for any other range: fetched by the plugins, then shown. `selection` opens the calendar
 *  on a range picked elsewhere (dragged across a chart). */
export function PeriodPicker({ file, current, selection }: { file: AnalyticsFile; current: AnalyticsCache; selection?: DateRange }) {
  const ui = useUi()
  const relative = file.periods.filter((p) => isRelative(p.key)).sort((a, b) => a.days - b.days)
  const saved = file.periods.filter((p) => !isRelative(p.key))
  const live = canFetchRanges()
  const [open, setOpen] = useState(false)
  const [from, setFrom] = useState<string | undefined>(current.range.from)
  const [to, setTo] = useState<string | undefined>(current.range.to)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const box = useRef<HTMLDivElement>(null)
  const go = (period: string | undefined) => ui.openTraffic({ app: ui.traffic.app, period }, false)
  const last = yesterday()

  // A range dragged on a chart: show it at once if it was fetched before, else open the calendar on it.
  useEffect(() => {
    if (!selection) return
    const known = file.periods.find((p) => p.range.from === selection.from && p.range.to === selection.to)
    if (known) return go(known.key)
    setFrom(selection.from)
    setTo(selection.to)
    setError(undefined)
    setOpen(true)
    requestAnimationFrame(() => box.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection])

  async function show() {
    if (!from || !to) return
    const known = file.periods.find((p) => p.range.from === from && p.range.to === to)
    if (known) {
      setOpen(false)
      return go(known.key)
    }
    setBusy(true)
    setError(undefined)
    const was = ui.traffic.period
    // The page reloads when the new period is written; this makes it open on that period.
    go(`${from}..${to}`)
    const failed = await fetchRange(from, to)
    setBusy(false)
    if (failed) {
      setError(failed)
      go(was)
    }
  }

  const known = !!from && !!to && file.periods.some((p) => p.range.from === from && p.range.to === to)
  return (
    <div className="period" ref={box}>
      <div className="period__bar">
        <div className="segmented" role="group" aria-label="Period">
          {relative.map((p) => (
            <button key={p.key} className={p.key === current.key ? 'is-active' : ''} aria-pressed={p.key === current.key} onClick={() => go(p.key)}>
              {p.days} days
            </button>
          ))}
          {live && (
            <button className={open || !isRelative(current.key) ? 'is-active' : ''} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              {isRelative(current.key) ? 'Pick dates' : periodLabel(current)}
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
      </div>
      {open && (
        <div className="period__panel">
          <div className="period__shortcuts">
            {shortcuts(last).map((s) => (
              <button
                key={s.label}
                className={`chip${s.from === from && s.to === to ? ' chip--active' : ''}`}
                onClick={() => {
                  setFrom(s.from)
                  setTo(s.to)
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
          <RangeCalendar
            from={from}
            to={to}
            min="2015-01-01"
            max={last}
            maxDays={MAX_DAYS}
            onChange={(f, t) => {
              setFrom(f)
              setTo(t)
              setError(undefined)
            }}
          />
          <div className="period__foot">
            <span className="period__summary" role="status">
              {error ??
                (busy
                  ? `Fetching ${shortDate(from!)} – ${shortDate(to!)} from each provider; answer any question a plugin asks.`
                  : from && to
                    ? `${shortDate(from)} – ${shortDate(to)}, ${from.slice(0, 4)} · ${daysBetween(from, to)} days, against the ${daysBetween(from, to)} before${known ? ' · fetched already' : ''}`
                    : from
                      ? `From ${shortDate(from)}: now pick the last day`
                      : 'Pick the first day')}
            </span>
            <button className="btn btn--primary" disabled={busy || !from || !to} onClick={() => void show()}>
              {busy ? 'Fetching…' : known ? 'Show' : 'Fetch and show'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
