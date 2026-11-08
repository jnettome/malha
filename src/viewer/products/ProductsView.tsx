import { motion } from 'motion/react'
import { useMemo, useState } from 'react'
import { apps, meta, model, singleNodeDatabases, workers } from '../model/model.ts'
import type { App } from '../../core/types.ts'
import { useUi } from '../ui/state.tsx'

const CATEGORIES: (App['category'] | 'all')[] = ['all', 'product', 'platform', 'internal', 'staging']
const DOMAIN_PREVIEW = 3
const DOT_CAP = 20

const podsOf = (a: App) => Object.values(a.pods ?? {}).reduce((s, v) => s + v, 0)

function Cell({ app, nodeId }: { app: App; nodeId: string }) {
  const pods = app.pods?.[nodeId] ?? 0
  const dbs = (app.databases ?? []).filter((d) => d.nodes.includes(nodeId))
  if (!pods && !dbs.length) return <td className="cell cell--empty">·</td>
  return (
    <td className="cell">
      {pods > 0 && (
        <span className="cell__pods" title={`${pods} pods`}>
          <span className="cell__dots" aria-hidden>
            {Array.from({ length: Math.min(pods, DOT_CAP) }, (_, i) => (
              <i key={i} />
            ))}
          </span>
          <span className="cell__n">{pods}</span>
        </span>
      )}
      {dbs.map((d) => (
        <span key={d.name} className={d.nodes.length === 1 ? 'db db--solo' : 'db'} title={`${d.name} (${d.engine})`}>
          ◆
        </span>
      ))}
    </td>
  )
}

export function ProductsView() {
  const ui = useUi()
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>('all')
  const [q, setQ] = useState('')

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase()
    return apps
      .filter((a) => category === 'all' || a.category === category)
      .filter((a) => !term || [a.name, a.id, ...(a.domains ?? [])].some((s) => s.toLowerCase().includes(term)))
      .sort((a, b) => podsOf(b) - podsOf(a) || a.name.localeCompare(b.name))
  }, [category, q])

  const soloCount = apps.filter((a) => singleNodeDatabases(a).length).length
  const domainCount = apps.reduce((s, a) => s + (a.domains?.length ?? 0), 0)

  return (
    <div className="products">
      <div className="page-intro">
        <span className="eyebrow eyebrow--accent">Products</span>
        <h1>
          {apps.length} apps behind {domainCount} names
        </h1>
        <p>
          Squares are pods on that worker, ◆ is a database replica.{meta.pods_sampled ? ` Pod counts are from ${meta.pods_sampled}.` : ''} {soloCount}{' '}
          {soloCount === 1 ? 'app keeps' : 'apps keep'} a database on a single node.
        </p>
      </div>

      <div className="filters">
        <div className="segmented" role="group" aria-label="Category">
          {CATEGORIES.map((c) => (
            <button key={c} className={category === c ? 'is-active' : undefined} onClick={() => setCategory(c)}>
              {c}
            </button>
          ))}
        </div>
        <input className="filters__q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by app or domain" aria-label="Filter" />
        <span className="filters__legend">
          <span className="db">◆</span> replica <span className="db db--solo">◆</span> only replica
        </span>
      </div>

      <div className="table-wrap">
        <table className="matrix">
          <thead>
            <tr>
              <th>App</th>
              <th>Domains</th>
              {workers.map((w) => (
                <th key={w.id} className="cell-head">
                  {w.name}
                </th>
              ))}
              <th>Elsewhere</th>
              <th>Talks to</th>
              <th>Risk</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a, i) => {
              const solo = singleNodeDatabases(a)
              const selected = ui.selection?.type === 'app' && ui.selection.id === a.id
              return (
                <motion.tr
                  key={a.id}
                  className={selected ? 'is-selected' : undefined}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(i * 0.025, 0.5) }}
                  onClick={() => ui.select(selected ? null : { type: 'app', id: a.id })}
                >
                  <td className="matrix__app">
                    <span className="matrix__name">{a.name}</span>
                    <span className={`cat cat--${a.category}`}>{a.category}</span>
                  </td>
                  <td className="matrix__domains">
                    {(a.domains ?? []).slice(0, DOMAIN_PREVIEW).join('  ')}
                    {(a.domains?.length ?? 0) > DOMAIN_PREVIEW && <span className="more">+{a.domains!.length - DOMAIN_PREVIEW}</span>}
                  </td>
                  {workers.map((w) => (
                    <Cell key={w.id} app={a} nodeId={w.id} />
                  ))}
                  <td className="matrix__else">{a.host ? model.nodeById.get(a.host)?.name : a.pods ? '' : 'not recorded'}</td>
                  <td className="matrix__uses">{(a.uses ?? []).map((id) => model.nodeById.get(id)?.name ?? id).join(', ')}</td>
                  <td className="matrix__risk">
                    {solo.map((d) => (
                      <span key={d.name} className="risk">
                        <span aria-hidden>▲</span> {d.name} on {model.nodeById.get(d.nodes[0])?.name ?? d.nodes[0]} only
                      </span>
                    ))}
                  </td>
                </motion.tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
