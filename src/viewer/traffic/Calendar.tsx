import { useState } from 'react'

// A range calendar: two months, click the first day then the last, with the days between shown as
// you go. Dates are YYYY-MM-DD strings throughout, in UTC, like the rest of the traffic data.

const DAY = 86_400_000
const toTime = (d: string) => Date.parse(`${d}T00:00:00Z`)
const toDay = (t: number) => new Date(t).toISOString().slice(0, 10)
export const addDays = (d: string, n: number) => toDay(toTime(d) + n * DAY)
export const daysBetween = (from: string, to: string) => Math.round((toTime(to) - toTime(from)) / DAY) + 1

/** "2026-10" plus or minus months. */
const addMonths = (month: string, n: number) => {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + n, 1))
  return d.toISOString().slice(0, 7)
}
const monthName = (month: string) => new Date(`${month}-01T12:00:00Z`).toLocaleDateString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const longDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

/** Shortcuts, ending by `last` (yesterday). */
export function shortcuts(last: string): { label: string; from: string; to: string }[] {
  const month = last.slice(0, 7)
  const prev = addMonths(month, -1)
  const year = Number(last.slice(0, 4))
  return [
    { label: 'This month', from: `${month}-01`, to: last },
    { label: 'Last month', from: `${prev}-01`, to: addDays(`${month}-01`, -1) },
    { label: 'Last 6 months', from: addDays(last, -181), to: last },
    { label: 'This year', from: `${year}-01-01`, to: last },
    { label: 'Last year', from: `${year - 1}-01-01`, to: `${year - 1}-12-31` },
  ].filter((s) => s.from <= s.to)
}

export function RangeCalendar({ from, to, min, max, maxDays, onChange }: { from?: string; to?: string; min: string; max: string; maxDays: number; onChange: (from: string | undefined, to: string | undefined) => void }) {
  // The right-hand month on screen.
  const [shown, setShown] = useState(() => (to ?? from ?? max).slice(0, 7))
  const [hover, setHover] = useState<string>()
  const months = [addMonths(shown, -1), shown]
  // While picking the last day: what the range would be.
  const end = to ?? (from && hover && hover >= from ? hover : undefined)
  const disabled = (d: string) => d > max || d < min || (!!from && !to && d >= from && daysBetween(from, d) > maxDays)

  function pick(d: string) {
    if (!from || to || d < from) onChange(d, undefined)
    else onChange(from, d)
  }

  return (
    <div className="cal" onMouseLeave={() => setHover(undefined)}>
      <div className="cal__nav">
        <button type="button" className="cal__step" aria-label="Earlier months" disabled={months[0] <= min.slice(0, 7)} onClick={() => setShown((m) => addMonths(m, -1))}>
          ‹
        </button>
        <button type="button" className="cal__step" aria-label="Later months" disabled={shown >= max.slice(0, 7)} onClick={() => setShown((m) => addMonths(m, 1))}>
          ›
        </button>
      </div>
      <div className="cal__months">
        {months.map((month) => {
          const first = toTime(`${month}-01`)
          const lead = new Date(first).getUTCDay()
          const count = daysBetween(`${month}-01`, addDays(`${addMonths(month, 1)}-01`, -1))
          return (
            <div key={month} className="cal__month" role="group" aria-label={monthName(month)}>
              <div className="cal__title">{monthName(month)}</div>
              <div className="cal__grid">
                {WEEKDAYS.map((w, i) => (
                  <span key={i} className="cal__weekday" aria-hidden>
                    {w}
                  </span>
                ))}
                {Array.from({ length: lead }, (_, i) => (
                  <span key={`pad${i}`} />
                ))}
                {Array.from({ length: count }, (_, i) => {
                  const d = toDay(first + i * DAY)
                  const edge = d === from || d === end
                  const inside = !!from && !!end && d > from && d < end
                  return (
                    <button
                      key={d}
                      type="button"
                      className={`cal__day${edge ? ' is-edge' : ''}${inside ? ' is-inside' : ''}`}
                      disabled={disabled(d)}
                      aria-label={longDate(d)}
                      aria-pressed={edge || inside}
                      onMouseEnter={() => setHover(d)}
                      onFocus={() => setHover(d)}
                      onClick={() => pick(d)}
                    >
                      {i + 1}
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
