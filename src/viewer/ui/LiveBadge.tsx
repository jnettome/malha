import { useEffect, useRef, useState } from 'react'
import { useLive } from '../live.ts'

const ago = (iso: string | undefined, now: number) => {
  if (!iso) return ''
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`
}

const STATE_LABEL = { starting: 'Starting', asking: 'Waiting for you', ok: 'Live', error: 'Error', stopped: 'Stopped' }

/** Shown while live plugins run: their state, and how fresh the data is. */
export function LiveBadge() {
  const live = useLive()
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  if (!live?.plugins.length) return null
  const ok = live.plugins.filter((p) => p.state === 'ok')
  const trouble = live.plugins.some((p) => p.state === 'error' || p.state === 'stopped')
  const asking = live.asks.length > 0 || live.plugins.some((p) => p.state === 'asking')
  const latest = ok.map((p) => p.at).sort().at(-1)
  const tone = asking ? 'asking' : trouble ? 'trouble' : ok.length ? 'ok' : 'starting'
  const label = asking ? 'Approve' : ok.length ? `Live · ${ago(latest, now)}` : trouble ? 'Live · error' : 'Live · starting'

  return (
    <div className="live" ref={ref}>
      <button className={`live__badge live__badge--${tone}`} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <i className="live__dot" aria-hidden />
        {label}
      </button>
      {open && (
        <div className="live__panel" role="dialog" aria-label="Live plugins">
          <span className="eyebrow">Live plugins</span>
          <ul>
            {live.plugins.map((p) => (
              <li key={p.name}>
                <span className="live__name">{p.name}</span>
                <span className={`live__state live__state--${p.state}`}>{STATE_LABEL[p.state]}</span>
                <span className="live__when">{p.state === 'ok' ? `${ago(p.at, now)} · every ${p.every} s` : ''}</span>
                {p.message && <p className="live__message">{p.message}</p>}
              </li>
            ))}
          </ul>
          <p className="live__foot">Values from live plugins replace the sampled ones in the file until this page closes. Network for plugins blocked by {live.network}.</p>
        </div>
      )}
    </div>
  )
}
