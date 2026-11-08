import { animate } from 'motion/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLive } from '../live.ts'
import { meta, model, totals, type SearchEntry } from '../model/model.ts'
import { LiveBadge } from './LiveBadge.tsx'
import { usePrefersReducedMotion, useUi, type View } from './state.tsx'

const VIEWS: { id: View; label: string }[] = [
  { id: 'topology', label: 'Topology' },
  { id: 'map', label: 'Map' },
  { id: 'fleet', label: 'Fleet' },
  { id: 'products', label: 'Products' },
  { id: 'domains', label: 'Domains' },
  { id: 'security', label: 'Security' },
]

function Mark() {
  return (
    <svg className="mark" viewBox="0 0 24 24" aria-hidden>
      <rect x="2.5" y="2.5" width="19" height="19" rx="1.5" />
      <path d="M6 8h12M6 12h12M6 16h7" />
      <circle cx="17" cy="16" r="1.4" className="mark__led" />
    </svg>
  )
}

function Search() {
  const ui = useUi()
  const input = useRef<HTMLInputElement>(null)
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(0)

  const results = useMemo(() => {
    const term = q.trim().toLowerCase()
    if (!term) return []
    return model.search.filter((e) => e.haystack.includes(term)).slice(0, 9)
  }, [q])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement
      if (e.key === '/' && !typing) {
        e.preventDefault()
        input.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const choose = (r: SearchEntry) => {
    ui.stopFlow()
    if (r.type === 'node') {
      ui.select({ type: 'node', id: r.id })
      if (ui.view === 'products') ui.setView('topology')
      ui.requestFocus([r.id])
    } else {
      ui.select({ type: 'app', id: r.id })
      const app = model.appById.get(r.id)
      const ids = [...Object.keys(app?.pods ?? {}), ...(app?.host ? [app.host] : [])]
      if (ids.length) ui.requestFocus(ids)
    }
    setQ('')
    setOpen(false)
    input.current?.blur()
  }

  return (
    <div className="search">
      <input
        ref={input}
        value={q}
        placeholder="Search machines, IPs, apps, domains"
        aria-label="Search"
        onChange={(e) => {
          setQ(e.target.value)
          setCursor(0)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setCursor((c) => Math.min(c + 1, results.length - 1))
          else if (e.key === 'ArrowUp') setCursor((c) => Math.max(c - 1, 0))
          else if (e.key === 'Enter' && results[cursor]) choose(results[cursor])
          else if (e.key === 'Escape') input.current?.blur()
          else return
          e.preventDefault()
        }}
      />
      <kbd>/</kbd>
      {open && results.length > 0 && (
        <ul className="search__results" role="listbox">
          {results.map((r, i) => (
            <li key={`${r.type}:${r.label}`} role="option" aria-selected={i === cursor}>
              <button onMouseDown={() => choose(r)} onMouseEnter={() => setCursor(i)} className={i === cursor ? 'is-cursor' : undefined}>
                <span className="search__type">{r.type}</span>
                <span className="search__label">{r.label}</span>
                <span className="search__detail">{r.detail}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function Header() {
  const ui = useUi()
  return (
    <header className="top">
      <div className="top__brand">
        <Mark />
        <span className="top__name">{meta.name}</span>
        <span className="top__slash">/</span>
        <nav className="tabs">
          {VIEWS.map((v) => (
            <button key={v.id} className={ui.view === v.id ? 'is-active' : undefined} onClick={() => ui.setView(v.id)}>
              {v.label}
            </button>
          ))}
        </nav>
      </div>
      <Search />
      <LiveBadge />
      <div className="top__meta">
        {meta.cluster && <span>{meta.cluster}</span>}
        {meta.kubernetes && <span>k8s {meta.kubernetes}</span>}
        <span>checked {meta.checked}</span>
      </div>
    </header>
  )
}

function CountUp({ value, decimals = 0 }: { value: number; decimals?: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  const reduced = usePrefersReducedMotion()
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (reduced) {
      el.textContent = value.toFixed(decimals)
      return
    }
    const controls = animate(0, value, {
      duration: 1.4,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => (el.textContent = v.toFixed(decimals)),
    })
    return () => controls.stop()
  }, [value, decimals, reduced])
  return <span ref={ref}>{value.toFixed(decimals)}</span>
}

export function Stats() {
  const t = useMemo(totals, [])
  const live = useLive()
  // Live pod counts replace the sampled ones node by node.
  const pods = live ? model.nodes.filter((n) => n.kind === 'worker' || n.kind === 'control-plane').reduce((s, n) => s + (live.nodes[n.id]?.pods ?? n.usage?.pods ?? 0), 0) : t.pods
  const livePods = Boolean(live && Object.values(live.nodes).some((n) => n.pods !== undefined))
  const stats: { label: string; value: number; unit?: string; decimals?: number; live?: boolean }[] = [
    { label: 'Cluster nodes', value: t.clusterNodes },
    { label: 'vCPU', value: t.vcpu },
    { label: 'Memory', value: t.memory, unit: 'GiB' },
    { label: 'Pods', value: pods, live: livePods },
    { label: 'Machines', value: t.machines },
    { label: 'Apps', value: t.apps },
    t.domains !== undefined ? { label: 'Domains', value: t.domains } : { label: 'Hostnames', value: t.hostnames },
  ]
  return (
    <div className="stats">
      {stats.map((s) => (
        <div key={s.label} className="stat">
          <span className="stat__label">
            {s.label}
            {s.live && <span className="stat__live"> · live</span>}
          </span>
          <span className="stat__value">
            <CountUp value={s.value} decimals={s.decimals} />
            {s.unit && <span className="stat__unit">{s.unit}</span>}
          </span>
        </div>
      ))}
    </div>
  )
}
