import { motion } from 'motion/react'
import { useMemo, useState, type CSSProperties } from 'react'
import { model } from '../model/model.ts'
import type { Domain } from '../../core/types.ts'
import { Led } from '../ui/parts.tsx'
import { useUi } from '../ui/state.tsx'
import { compact, daysLeft, domainList, domainsChecked, SOON_DAYS, URGENT_DAYS, usesOf } from './domains.ts'

type Filter = 'all' | 'soon' | 'idle' | 'elsewhere'
type SortKey = 'expires' | 'name' | 'visitors' | 'insights'

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'soon', label: `Renew within ${SOON_DAYS} d` },
  { id: 'idle', label: 'Serving nothing here' },
  { id: 'elsewhere', label: 'Registered elsewhere' },
]

const providerName = (id?: string) => (id ? (model.providerById.get(id)?.name ?? id) : undefined)
const servesNothing = (d: Domain) => {
  const u = usesOf(d.name)
  return u.apps.length === 0 && u.nodes.every((n) => n.status === 'retired')
}
const urgency = (days?: number) => (days === undefined ? 'none' : days < 0 ? 'expired' : days <= URGENT_DAYS ? 'urgent' : days <= SOON_DAYS ? 'soon' : 'ok')

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function RenewalCalendar({ rows }: { rows: { d: Domain; days?: number }[] }) {
  const [hover, setHover] = useState<string | null>(null)
  const dated = rows.filter((r) => r.d.expires)
  if (!dated.length) return null
  const now = new Date()
  const key = (iso: string) => iso.slice(0, 7)
  const last = dated.map((r) => r.d.expires!).sort().at(-1)!
  // One column per month, from this month to the last expiry. The year shows on the first column and on January.
  const months: { key: string; label: string; year?: number }[] = []
  for (const at = new Date(now.getFullYear(), now.getMonth(), 1); ; at.setMonth(at.getMonth() + 1)) {
    const k = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`
    if (k > key(last)) break
    months.push({ key: k, label: MONTHS[at.getMonth()], year: at.getMonth() === 0 || months.length === 0 ? at.getFullYear() : undefined })
  }
  const byMonth = new Map(months.map((mo) => [mo.key, dated.filter((r) => key(r.d.expires!) === mo.key).sort((a, b) => a.d.expires!.localeCompare(b.d.expires!))]))
  const tallest = Math.max(1, ...[...byMonth.values()].map((v) => v.length))
  const hovered = dated.find((r) => r.d.name === hover)

  return (
    <section className="calendar" aria-label="Renewal calendar">
      <header className="calendar__head">
        <h2 className="eyebrow">Renewals, next {months.length} months</h2>
        <span className="calendar__legend">
          <i className="cal-sq" /> expires that month
          <i className="cal-sq cal-sq--urgent" /> ▲ within {URGENT_DAYS} days
        </span>
      </header>
      <div className="calendar__grid" style={{ '--months': months.length, '--rows': tallest } as CSSProperties}>
        {months.map((mo, i) => {
          const list = byMonth.get(mo.key) ?? []
          const urgent = list.filter((r) => urgency(r.days) === 'urgent' || urgency(r.days) === 'expired')
          return (
            <div key={mo.key} className={`calendar__month${i === 0 ? ' is-now' : ''}`}>
              {urgent.length > 0 && <span className="calendar__call">▲ {urgent.length}</span>}
              <div className="calendar__stack">
                {list.map((r, j) => (
                  <motion.button
                    key={r.d.name}
                    className={`cal-sq cal-sq--${urgency(r.days)}${hover === r.d.name ? ' is-hover' : ''}`}
                    initial={{ opacity: 0, scale: 0.4 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: 0.15 + i * 0.03 + j * 0.04 }}
                    onMouseEnter={() => setHover(r.d.name)}
                    onMouseLeave={() => setHover(null)}
                    onFocus={() => setHover(r.d.name)}
                    onBlur={() => setHover(null)}
                    aria-label={`${r.d.name} expires ${r.d.expires}`}
                  />
                ))}
              </div>
              <span className="calendar__label">
                {mo.label}
                {mo.year && <b>{String(mo.year).slice(2)}</b>}
              </span>
            </div>
          )
        })}
      </div>
      <p className="calendar__tip" aria-live="polite">
        {hovered ? (
          <>
            <b>{hovered.d.name}</b> expires {hovered.d.expires}, {hovered.days !== undefined && hovered.days < 0 ? `${-hovered.days} days ago` : `in ${hovered.days} days`}
          </>
        ) : (
          'Point at a square for the domain.'
        )}
      </p>
    </section>
  )
}

export function DomainsView() {
  const ui = useUi()
  const [filter, setFilter] = useState<Filter>('all')
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'expires', desc: false })

  const all = useMemo(() => domainList.map((d) => ({ d, days: daysLeft(d.expires) })), [])
  const maxVisitors = Math.max(1, ...all.map((r) => r.d.visitors ?? 0))
  const urgent = all.filter((r) => urgency(r.days) === 'urgent' || urgency(r.days) === 'expired').sort((a, b) => a.days! - b.days!)

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase()
    const filtered = all.filter(({ d, days }) => {
      if (term && !d.name.includes(term) && !usesOf(d.name).apps.some((a) => a.name.toLowerCase().includes(term))) return false
      if (filter === 'soon') return days !== undefined && days <= SOON_DAYS
      if (filter === 'idle') return servesNothing(d)
      if (filter === 'elsewhere') return !d.registrar
      return true
    })
    const value = (r: (typeof all)[number]): number | string =>
      sort.key === 'name' ? r.d.name : sort.key === 'visitors' ? (r.d.visitors ?? -1) : sort.key === 'insights' ? (r.d.insights ?? -1) : (r.days ?? Infinity)
    return filtered.sort((a, b) => {
      const va = value(a)
      const vb = value(b)
      const c = typeof va === 'string' ? va.localeCompare(vb as string) : va - (vb as number)
      return sort.desc ? -c : c
    })
  }, [all, filter, q, sort])

  const sortBy = (key: SortKey) => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key === 'visitors' || key === 'insights' }))
  const arrow = (key: SortKey) => (sort.key === key ? (sort.desc ? ' ↓' : ' ↑') : '')

  // One tile per registrar and per DNS host named in the data.
  const byProvider = (field: 'registrar' | 'dns', label: string) =>
    [...new Set(all.map((r) => r.d[field]).filter((v): v is string => Boolean(v)))].map((id) => ({
      label: `${label} ${providerName(id)}`,
      value: all.filter((r) => r.d[field] === id).length,
    }))
  const insights = all.reduce((s, r) => s + (r.d.insights ?? 0), 0)
  const tiles: { label: string; value: number; warn?: boolean }[] = [
    { label: `Renew within ${URGENT_DAYS} days`, value: urgent.length, warn: urgent.length > 0 },
    ...byProvider('registrar', 'Registered at'),
    ...byProvider('dns', 'DNS on'),
    { label: 'Serving nothing here', value: all.filter((r) => servesNothing(r.d)).length },
    ...(insights ? [{ label: 'Open security insights', value: insights }] : []),
  ]

  return (
    <div className="domains">
      <div className="page-intro">
        <span className="eyebrow eyebrow--accent">Domains</span>
        <h1>
          {all.length} domains
          {urgent.length > 0 && (
            <>
              , {urgent.length} to renew within {URGENT_DAYS} days
            </>
          )}
        </h1>
        <p>
          {urgent.length > 0 && (
            <>
              {urgent.map((r) => `${r.d.name} (${r.days} d${servesNothing(r.d) ? ', serving nothing here' : ''})`).join(', ')}.{' '}
            </>
          )}
          {domainsChecked ? `Registrar and DNS data as of ${domainsChecked}. ` : ''}Days left count from today.
        </p>
      </div>

      <div className="tiles">
        {tiles.map((t, i) => (
          <motion.div key={t.label} className={`tile${t.warn ? ' tile--warn' : ''}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
            <span className="tile__label">
              {t.warn && <span aria-hidden>▲ </span>}
              {t.label}
            </span>
            <span className="tile__value">{t.value}</span>
          </motion.div>
        ))}
      </div>

      <RenewalCalendar rows={all} />

      <div className="filters">
        <div className="segmented" role="group" aria-label="Filter">
          {FILTERS.map((f) => (
            <button key={f.id} className={filter === f.id ? 'is-active' : undefined} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        <input className="filters__q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by domain or app" aria-label="Filter domains" />
        <span className="filters__legend">{rows.length} shown</span>
      </div>

      <div className="dom" role="table" aria-label="Domains">
        <div className="dom__row dom__row--head" role="row">
          <button role="columnheader" onClick={() => sortBy('name')}>
            Domain{arrow('name')}
          </button>
          <span role="columnheader">Serves</span>
          <button role="columnheader" onClick={() => sortBy('expires')}>
            Expires{arrow('expires')}
          </button>
          <button role="columnheader" onClick={() => sortBy('visitors')}>
            Visitors{arrow('visitors')}
          </button>
          <button role="columnheader" onClick={() => sortBy('insights')}>
            Insights{arrow('insights')}
          </button>
        </div>
        {rows.map(({ d, days }, i) => {
          const u = usesOf(d.name)
          const level = urgency(days)
          const notes = d.notes === undefined ? [] : Array.isArray(d.notes) ? d.notes : [d.notes]
          return (
            <motion.div
              key={d.name}
              role="row"
              className={`dom__row dom__row--${level}`}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(i * 0.015, 0.4) }}
            >
              <div className="dom__name" role="cell">
                <span className="dom__domain">{d.name}</span>
                <span className="dom__meta">
                  {providerName(d.registrar) ?? 'registered elsewhere'} · {providerName(d.dns) ?? 'DNS elsewhere'}
                  {d.plan ? ` ${d.plan}` : ''}
                  {d.auto_renew === true && ' · auto-renew'}
                </span>
                {d.auto_renew === false && (
                  <span className="dom__warn">
                    <span aria-hidden>▲ </span>auto-renew off
                  </span>
                )}
                {notes.map((n) => (
                  <span key={n} className="dom__note">
                    {n}
                  </span>
                ))}
              </div>
              <div className="dom__serves" role="cell">
                {u.apps.map((a) => (
                  <button key={a.id} className="chip-btn" onClick={() => ui.select({ type: 'app', id: a.id })}>
                    {a.name}
                  </button>
                ))}
                {u.nodes.slice(0, u.apps.length ? 2 : 4).map((n) => (
                  <button key={n.id} className="chip-btn chip-btn--node" onClick={() => ui.select({ type: 'node', id: n.id })}>
                    <Led status={n.status} />
                    {n.name}
                  </button>
                ))}
                {u.nodes.length > (u.apps.length ? 2 : 4) && <span className="dom__more">+{u.nodes.length - (u.apps.length ? 2 : 4)} machines</span>}
                {servesNothing(d) && <span className="dom__none">Nothing in this map</span>}
              </div>
              <div className="dom__expiry" role="cell">
                {d.expires ? (
                  <>
                    <span className="dom__date">{d.expires}</span>
                    <span className="dom__days">
                      {(level === 'urgent' || level === 'expired') && <span className="warn-icon" aria-hidden>▲ </span>}
                      {days! < 0 ? `expired ${-days!} d ago` : `in ${days} d`}
                    </span>
                    <span className="dom__bar">
                      <span style={{ width: `${Math.max(2, Math.min(100, (Math.max(0, days!) / 365) * 100))}%` }} />
                    </span>
                  </>
                ) : (
                  <span className="dom__none">Expiry not tracked</span>
                )}
              </div>
              <div className="dom__visitors" role="cell">
                {d.visitors !== undefined ? (
                  <>
                    <span>{compact.format(d.visitors)}</span>
                    <span className="dom__bar dom__bar--traffic">
                      <span style={{ width: `${Math.max(1.5, (d.visitors / maxVisitors) * 100)}%` }} />
                    </span>
                  </>
                ) : (
                  <span className="dom__none">—</span>
                )}
              </div>
              <div className="dom__insights" role="cell">
                {d.insights ?? '—'}
              </div>
            </motion.div>
          )
        })}
      </div>
    </div>
  )
}
