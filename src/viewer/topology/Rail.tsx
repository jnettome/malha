import { AnimatePresence, motion } from 'motion/react'
import { flows, networks, node } from '../model/model.ts'
import type { LinkKind } from '../../core/types.ts'
import { FAMILIES, KIND_ORDER, KINDS, type Family } from '../ui/kinds.ts'
import { KindSwatch } from '../ui/parts.tsx'
import { LAST_STEP_HOLD, STEP_MS, useUi } from '../ui/state.tsx'

const byFamily = (Object.keys(FAMILIES) as Family[]).map((f) => ({
  family: f,
  kinds: KIND_ORDER.filter((k) => KINDS[k].family === f),
}))

const endpointName = (id: string) => node(id)?.name ?? id

function FlowPlayer() {
  const ui = useUi()
  const flow = flows.find((f) => f.id === ui.flow?.id)
  if (!ui.flow || !flow) return null
  const { step, playing } = ui.flow
  const last = flow.steps.length - 1

  return (
    <motion.div className="player" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
      <div className="player__head">
        <span className="eyebrow eyebrow--accent">Now tracing</span>
        <button className="btn btn--ghost" onClick={ui.stopFlow}>
          Stop
        </button>
      </div>
      <ol className="player__steps">
        {flow.steps.map((s, i) => (
          <li key={i} className={i === step ? 'is-current' : i < step ? 'is-done' : undefined}>
            <button onClick={() => ui.setStep(i)}>
              <span className="player__n">{String(i + 1).padStart(2, '0')}</span>
              <span className="player__text">
                <span className="player__hop">
                  {endpointName(s.from)} → {endpointName(s.to)}
                </span>
                {i === step && (
                  <motion.span className="player__label" initial={{ opacity: 0 }} animate={{ opacity: 1 }} key={`${flow.id}-${i}`}>
                    {s.label}
                  </motion.span>
                )}
              </span>
            </button>
            {i === step && playing && (
              <span
                className="player__progress"
                key={`${flow.id}-p-${i}`}
                style={{ animationDuration: `${i === last ? STEP_MS * LAST_STEP_HOLD : STEP_MS}ms` }}
              />
            )}
          </li>
        ))}
      </ol>
      <div className="player__controls">
        <button className="btn" onClick={() => ui.setStep(Math.max(0, step - 1))} disabled={step === 0} aria-label="Previous step">
          ←
        </button>
        <button className="btn btn--primary" onClick={ui.togglePlay}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <button className="btn" onClick={() => ui.setStep(Math.min(last, step + 1))} disabled={step === last} aria-label="Next step">
          →
        </button>
      </div>
    </motion.div>
  )
}

export function LayerToggle({ kind }: { kind: LinkKind }) {
  const ui = useUi()
  const on = !ui.hidden.has(kind)
  return (
    <label className={`layer${on ? '' : ' is-off'}`}>
      <input type="checkbox" checked={on} onChange={() => ui.toggleKind(kind)} />
      <KindSwatch kind={kind} />
      <span>{KINDS[kind].label}</span>
    </label>
  )
}

export function Rail() {
  const ui = useUi()
  return (
    <aside className="rail">
      <section>
        <h2 className="eyebrow">Data flows</h2>
        <ul className="flows">
          {flows.map((f) => (
            <li key={f.id}>
              <button
                className={`flow-btn${ui.flow?.id === f.id ? ' is-active' : ''}`}
                onClick={() => (ui.flow?.id === f.id ? ui.stopFlow() : ui.playFlow(f.id))}
              >
                <KindSwatch kind={f.kind} width={18} />
                <span>{f.name}</span>
                <span className="flow-btn__n">{f.steps.length}</span>
              </button>
            </li>
          ))}
        </ul>
        <AnimatePresence mode="wait">{ui.flow && <FlowPlayer key={ui.flow.id} />}</AnimatePresence>
      </section>

      <section>
        <h2 className="eyebrow">Layers</h2>
        {byFamily.map(({ family, kinds }) => (
          <div key={family} className="layer-group">
            <span className="layer-group__name">{FAMILIES[family].name}</span>
            {kinds.map((k) => (
              <LayerToggle key={k} kind={k} />
            ))}
          </div>
        ))}
        <label className="layer layer--option">
          <input type="checkbox" checked={ui.showRetired} onChange={(e) => ui.setShowRetired(e.target.checked)} />
          <span>Show retired machines</span>
        </label>
      </section>

      <section>
        <h2 className="eyebrow">Networks</h2>
        <dl className="nets">
          {networks
            .filter((n) => n.cidr)
            .map((n) => (
              <div key={n.id}>
                <dt>{n.name}</dt>
                <dd>{n.cidr}</dd>
              </div>
            ))}
        </dl>
      </section>
    </aside>
  )
}
