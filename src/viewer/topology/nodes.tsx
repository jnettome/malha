import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { InfraNode, Zone } from '../../core/types.ts'
import { model, notesOf } from '../model/model.ts'
import { NODE_KIND_LABEL } from '../ui/kinds.ts'
import { Corners, FrontPanel, Led, Meter, Monogram, PodGrid } from '../ui/parts.tsx'
import { useLiveNode } from '../live.ts'

export type Emphasis = 'normal' | 'dim' | 'lit' | 'selected'

export interface Badge {
  pods: number
  databases: string[]
  uses: boolean
}

export type InfraFlowNode = Node<{ node: InfraNode; emphasis: Emphasis; badge?: Badge }, 'infra'>
export type ZoneFlowNode = Node<{ zone: Zone; index: number; dim: boolean }, 'zone'>
export type RegionFlowNode = Node<{ label: string; detail: string; dim: boolean }, 'region'>

const SIDES = [
  ['top', Position.Top],
  ['right', Position.Right],
  ['bottom', Position.Bottom],
  ['left', Position.Left],
] as const

/** Every card can send or receive on any side; the layout picks which. */
function Handles() {
  return SIDES.map(([side, position]) => [
    <Handle key={`${side}-s`} id={`${side}-s`} type="source" position={position} isConnectable={false} />,
    <Handle key={`${side}-t`} id={`${side}-t`} type="target" position={position} isConnectable={false} />,
  ])
}

function Addresses({ n }: { n: InfraNode }) {
  const provider = n.provider ? model.providerById.get(n.provider)?.name : undefined
  // Every address the file gives, in its order (wg, public, lan, mesh, …), then the provider.
  const rows = [
    ...Object.entries(n.addresses ?? {}).map(([k, v]): [string, string] => [k === 'public' ? 'pub' : k.slice(0, 4), v]),
    ['via', provider],
  ].filter((r): r is [string, string] => Boolean(r[1]))
  return (
    <dl className="card__addr">
      {rows.slice(0, 3).map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

function BadgeStrip({ badge }: { badge: Badge }) {
  return (
    <div className="card__badge">
      {badge.pods > 0 && <span>{badge.pods} pods</span>}
      {badge.databases.map((d) => (
        <span key={d} className="card__badge-db">
          ◆ {d}
        </span>
      ))}
      {badge.uses && !badge.pods && !badge.databases.length && <span>used</span>}
    </div>
  )
}

export function InfraCard({ data }: NodeProps<InfraFlowNode>) {
  const { node: n, emphasis, badge } = data
  const { usage, status } = useLiveNode(n)
  const machine = n.kind !== 'saas' && n.kind !== 'users'
  const cluster = n.kind === 'worker' || n.kind === 'control-plane'

  return (
    <div className={`card card--${n.kind} is-${emphasis} status-${status}`}>
      <Handles />
      <Corners />
      <header className="card__head">
        {n.kind === 'saas' ? <Monogram id={n.id} name={n.name} /> : <Led status={status} />}
        <span className="card__name">{n.name}</span>
        <span className="card__kind">{NODE_KIND_LABEL[n.kind]}</span>
      </header>

      {machine && n.kind !== 'workstation' && <FrontPanel cpu={usage?.cpu_pct} status={status} />}

      {n.kind === 'users' && (
        <>
          <p className="card__note">{notesOf(n.notes)[0]}</p>
          <Globe />
        </>
      )}

      {n.kind === 'users' ? null : cluster ? (
        <div className="card__body card__body--split">
          <Addresses n={n} />
          <div className="card__meters">
            <Meter label="cpu" pct={usage?.cpu_pct} />
            <Meter label="mem" pct={usage?.memory_pct} />
            <div className="card__spec">
              {n.hardware?.cpu} vCPU · {n.hardware?.memory_gib} GiB
            </div>
          </div>
        </div>
      ) : n.kind === 'proxy' ? (
        <div className="card__body">
          <Addresses n={n} />
          <ul className="card__runs">{n.runs?.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
      ) : (
        <div className="card__body">
          {n.host && n.kind !== 'saas' && <div className="card__host">{n.host}</div>}
          {n.kind === 'server' && n.addresses && <div className="card__host">{Object.values(n.addresses)[0]}</div>}
          <ul className="card__runs">
            {(n.runs ?? []).slice(0, n.kind === 'saas' ? 2 : 3).map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      {n.kind === 'worker' && <PodGrid n={n} compact />}
      {badge && <BadgeStrip badge={badge} />}
    </div>
  )
}

function Globe() {
  return (
    <svg className="globe" viewBox="0 0 64 64" aria-hidden>
      <circle cx="32" cy="32" r="26" />
      <ellipse cx="32" cy="32" rx="11" ry="26" />
      <ellipse cx="32" cy="32" rx="22" ry="26" className="globe__spin" />
      <line x1="6" y1="32" x2="58" y2="32" />
      <path d="M10 19 H54 M10 45 H54" />
    </svg>
  )
}

export function ZoneFrame({ data }: NodeProps<ZoneFlowNode>) {
  const { zone, index, dim } = data
  return (
    <div className={`zone${dim ? ' is-dim' : ''}`}>
      <Handles />
      <span className="zone__label">
        <b>{String(index + 1).padStart(2, '0')}</b> {zone.name}
      </span>
      {zone.description && (
        <span className="zone__desc" title={zone.description}>
          {zone.description}
        </span>
      )}
    </div>
  )
}

export function RegionFrame({ data }: NodeProps<RegionFlowNode>) {
  return (
    <div className={`region${data.dim ? ' is-dim' : ''}`}>
      <span className="region__label">
        <i className="region__pulse" aria-hidden />
        {data.label}
        <span>{data.detail}</span>
      </span>
    </div>
  )
}
