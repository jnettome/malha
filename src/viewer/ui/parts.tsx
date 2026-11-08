import type { CSSProperties } from 'react'
import type { InfraNode, LinkKind, NodeStatus } from '../../core/types.ts'
import { useLiveNode } from '../live.ts'
import { podPressure } from '../model/model.ts'
import { FAMILIES, KINDS, STATUS_LABEL } from './kinds.ts'

export const PRESSURE_WARN = 0.8

export function Led({ status = 'active' }: { status?: NodeStatus }) {
  return <i className={`led led--${status}`} aria-label={STATUS_LABEL[status]} role="img" />
}

/** Sled front panel: vents plus activity LEDs that blink faster as CPU climbs. */
export function FrontPanel({ cpu, status = 'active', tall = false }: { cpu?: number; status?: NodeStatus; tall?: boolean }) {
  const period = cpu === undefined ? 2.6 : Math.max(0.3, 2.4 - (cpu / 100) * 2.2)
  const live = status === 'active' || status === 'degraded'
  return (
    <div className={`panel${tall ? ' panel--tall' : ''}${live ? '' : ' panel--off'}`} aria-hidden>
      <span className="panel__vents" />
      <span className="panel__leds">
        <i className="panel__led panel__led--power" />
        <i className="panel__led" style={{ animationDuration: `${period}s` }} />
        <i className="panel__led" style={{ animationDuration: `${period * 1.37}s`, animationDelay: `${period * 0.4}s` }} />
      </span>
    </div>
  )
}

export function Meter({ label, pct, detail }: { label: string; pct?: number; detail?: string }) {
  const known = pct !== undefined
  const warn = known && pct / 100 >= PRESSURE_WARN
  return (
    <div className={`meter${warn ? ' meter--warn' : ''}`}>
      <span className="meter__label">{label}</span>
      <span className="meter__track">
        {known && <span className="meter__fill" style={{ '--pct': `${Math.max(pct, 1.5)}%` } as CSSProperties} />}
      </span>
      <span className="meter__value">{known ? `${Math.round(pct)}%` : '—'}</span>
      {detail && <span className="meter__detail">{detail}</span>}
    </div>
  )
}

/** One square per running pod, outlined squares for the rest of max_pods. */
export function PodGrid({ n, compact = false }: { n: InfraNode; compact?: boolean }) {
  const { usage } = useLiveNode(n)
  const pods = usage?.pods ?? 0
  const max = n.hardware?.max_pods ?? pods
  const pressure = podPressure(n, usage) ?? 0
  return (
    <div className={`pods${compact ? ' pods--compact' : ''}${pressure >= PRESSURE_WARN ? ' pods--warn' : ''}`}>
      <div className="pods__grid" aria-hidden>
        {Array.from({ length: max }, (_, i) => (
          <i key={i} className={i < pods ? 'on' : undefined} style={{ animationDelay: `${i * 6}ms` }} />
        ))}
      </div>
      <span className="pods__value">
        {pressure >= PRESSURE_WARN && <span className="warn-icon" aria-hidden>▲ </span>}
        {pods}
        <span className="pods__max">/{max} pods</span>
      </span>
    </div>
  )
}

export function KindSwatch({ kind, width = 28 }: { kind: LinkKind; width?: number }) {
  const k = KINDS[kind]
  return (
    <svg className="swatch" width={width} height="8" aria-hidden>
      <line x1="1" y1="4" x2={width - 1} y2="4" stroke={FAMILIES[k.family].line} strokeWidth="2" strokeDasharray={k.dash} strokeLinecap="round" />
    </svg>
  )
}

/** Two-letter mark for services that have no hardware to draw. */
export function Monogram({ id, name }: { id: string; name: string }) {
  const caps = name.match(/[A-Z0-9]/g)?.join('') ?? ''
  const text = id.length <= 3 ? id : caps.length >= 2 ? caps.slice(0, 3) : name.slice(0, 2)
  return (
    <span className="monogram" aria-hidden>
      {text.toUpperCase()}
    </span>
  )
}

export function Corners() {
  return <span className="corners" aria-hidden />
}
