import { motion } from 'motion/react'
import { model, providers } from '../model/model.ts'
import type { InfraNode } from '../../core/types.ts'
import { NODE_KIND_LABEL } from '../ui/kinds.ts'
import { FrontPanel, Led, Meter, Monogram } from '../ui/parts.tsx'
import { useUi } from '../ui/state.tsx'
import { useLiveNode } from '../live.ts'

const RACK_UNITS = 6

const isMachine = (n: InfraNode) => n.kind !== 'saas' && n.kind !== 'users'
// Big boxes take two units, as they would in a real rack.
const unitsOf = (n: InfraNode) => ((n.hardware?.cpu ?? 0) >= 32 ? 2 : 1)

interface Rack {
  id: string
  name: string
  detail: string
  machines: InfraNode[]
}

function racks(): Rack[] {
  const machines = model.nodes.filter(isMachine)
  const known = providers
    .map((p) => ({
      id: p.id,
      name: p.name,
      detail: [p.kind, p.location, p.asn, p.network].filter(Boolean).join(' · '),
      machines: machines.filter((m) => m.provider === p.id),
    }))
    .filter((r) => r.machines.length)
  const unassigned = machines.filter((m) => !m.provider || !model.providerById.has(m.provider))
  return unassigned.length ? [...known, { id: '_', name: 'Unassigned', detail: 'no provider recorded', machines: unassigned }] : known
}

function Sled({ n, delay }: { n: InfraNode; delay: number }) {
  const ui = useUi()
  const { usage, status } = useLiveNode(n)
  const units = unitsOf(n)
  const selected = ui.selection?.type === 'node' && ui.selection.id === n.id
  const spec = [n.hardware?.cpu && `${n.hardware.cpu} vCPU`, n.hardware?.memory_gib && `${n.hardware.memory_gib} GiB`].filter(Boolean).join(' · ')
  const kind = units === 1 && n.kind === 'control-plane' ? 'Control' : NODE_KIND_LABEL[n.kind]
  return (
    <motion.button
      className={`sled sled--u${units} status-${status}${selected ? ' is-selected' : ''}`}
      style={{ gridRow: `span ${units}` }}
      initial={{ x: 28, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={{ delay, type: 'spring', stiffness: 260, damping: 28 }}
      onClick={() => ui.select(selected ? null : { type: 'node', id: n.id })}
    >
      <FrontPanel cpu={usage?.cpu_pct} status={status} tall={units === 2} />
      <span className="sled__text">
        <span className="sled__row">
          <Led status={status} />
          <span className="sled__name">{n.name}</span>
          <span className="sled__kind">{kind}</span>
        </span>
        <span className="sled__row sled__row--meta">
          <span>{Object.values(n.addresses ?? {})[0] ?? n.host ?? ''}</span>
          <span>{spec}</span>
        </span>
        {units === 2 && usage && (
          <span className="sled__meters">
            <Meter label="cpu" pct={usage.cpu_pct} />
            <Meter label="mem" pct={usage.memory_pct} />
          </span>
        )}
      </span>
    </motion.button>
  )
}

export function FleetView() {
  const list = racks()
  const services = model.nodes.filter((n) => n.kind === 'saas')
  const all = list.flatMap((r) => r.machines)
  const retired = all.filter((m) => m.status === 'retired').length

  return (
    <div className="fleet">
      <div className="page-intro">
        <span className="eyebrow eyebrow--accent">Fleet</span>
        <h1>
          {all.length - retired} machines with {list.length} providers
        </h1>
        <p>One rack per provider. Two-unit sleds have 32 or more vCPU. LEDs blink faster as CPU climbs; dark panels are idle{retired ? `, and ${retired} retired box is drawn dashed` : ''}.</p>
      </div>

      <div className="racks">
        {list.map((r, ri) => {
          const vcpu = r.machines.reduce((s, m) => s + (m.hardware?.cpu ?? 0), 0)
          const mem = r.machines.reduce((s, m) => s + (m.hardware?.memory_gib ?? 0), 0)
          const used = r.machines.reduce((s, m) => s + unitsOf(m), 0)
          return (
            <motion.section
              key={r.id}
              className="rack"
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: ri * 0.07, duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
            >
              <header className="rack__head">
                <h2>{r.name}</h2>
                <span>{r.detail}</span>
              </header>
              <div className="rack__frame">
                <span className="rack__rail" aria-hidden />
                <div className="rack__units" style={{ gridTemplateRows: `repeat(${Math.max(RACK_UNITS, used)}, 46px)` }}>
                  {r.machines.map((m, i) => (
                    <Sled key={m.id} n={m} delay={0.2 + ri * 0.07 + i * 0.06} />
                  ))}
                  {Array.from({ length: Math.max(0, RACK_UNITS - used) }, (_, i) => (
                    <span key={i} className="rack__blank" aria-hidden />
                  ))}
                </div>
                <span className="rack__rail" aria-hidden />
              </div>
              <footer className="rack__foot">
                <span>{r.machines.length} machines</span>
                <span>
                  {vcpu ? `${vcpu} vCPU` : ''}
                  {mem ? ` · ${Math.round(mem)} GiB` : ''}
                </span>
              </footer>
            </motion.section>
          )
        })}
      </div>

      <section className="fleet__services">
        <span className="eyebrow">Services we rent</span>
        <div className="service-strip">
          {services.map((s, i) => (
            <ServiceTile key={s.id} n={s} delay={0.4 + i * 0.05} />
          ))}
        </div>
      </section>
    </div>
  )
}

function ServiceTile({ n, delay }: { n: InfraNode; delay: number }) {
  const ui = useUi()
  return (
    <motion.button
      className="service-tile"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay }}
      onClick={() => ui.select({ type: 'node', id: n.id })}
    >
      <Monogram id={n.id} name={n.name} />
      <span className="service-tile__name">{n.name}</span>
      <span className="service-tile__runs">{n.runs?.[0]}</span>
    </motion.button>
  )
}
