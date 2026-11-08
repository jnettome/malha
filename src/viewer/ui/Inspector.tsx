import { AnimatePresence, motion } from 'motion/react'
import type { ReactNode } from 'react'
import { edgesOf, covers, model, node, notesOf, placementsOn, podPressure, singleNodeDatabases } from '../model/model.ts'
import type { App, InfraNode } from '../../core/types.ts'
import { siteById, sitesOf } from '../map/sites.ts'
import { reposOf, sumCounts, useScan } from '../security/security.ts'
import { SeverityChip } from '../security/SecurityView.tsx'
import { SEVERITIES } from '../../core/security.ts'
import { KINDS, NODE_KIND_LABEL, STATUS_LABEL } from './kinds.ts'
import { FrontPanel, KindSwatch, Led, Meter, PodGrid } from './parts.tsx'
import { BarList, SeriesChart } from '../traffic/charts.tsx'
import { panelUrl, pickPeriod, sourceId } from '../../core/analytics.ts'
import { fmtFull, periodLabel, PROVIDER_LABEL, siteRows, useAnalytics } from '../traffic/data.ts'
import { useUi } from './state.tsx'
import { useLiveNode } from '../live.ts'

const siteNames = (n: InfraNode) =>
  sitesOf(n)
    .map((id) => siteById.get(id))
    .filter((s) => s !== undefined)
    .map((s) => `${s.name}${s.region ? ` (${s.region})` : ''}`)
    .join(', ') || undefined

const nameOf = (id: string) => node(id)?.name ?? model.zoneById.get(id)?.name ?? id

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="insp__section">
      <h3 className="eyebrow">{title}</h3>
      {children}
    </section>
  )
}

function Spec({ rows }: { rows: [string, ReactNode | undefined][] }) {
  const present = rows.filter(([, v]) => v !== undefined && v !== '')
  if (!present.length) return null
  return (
    <dl className="spec">
      {present.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

function Jump({ id, children }: { id: string; children: ReactNode }) {
  const ui = useUi()
  const isNode = model.nodeById.has(id)
  return (
    <button className="jump" disabled={!isNode} onClick={() => ui.select({ type: 'node', id })}>
      {children}
    </button>
  )
}

function NodeDetail({ n }: { n: InfraNode }) {
  const ui = useUi()
  const { usage, status, live } = useLiveNode(n)
  const provider = n.provider ? model.providerById.get(n.provider) : undefined
  const placements = placementsOn(n.id).sort((a, b) => b.pods - a.pods)
  const connections = edgesOf(n.id)
  const pressure = podPressure(n, usage)

  return (
    <>
      <header className="insp__head">
        <span className="eyebrow">{NODE_KIND_LABEL[n.kind]}</span>
        <h2>{n.name}</h2>
        {n.host && <p className="insp__host">{n.host}</p>}
        <span className={`chip chip--${status}`}>
          <Led status={status} /> {STATUS_LABEL[status]}
        </span>
      </header>

      {n.kind !== 'saas' && n.kind !== 'users' && <FrontPanel cpu={usage?.cpu_pct} status={status} tall />}

      <Section title="Identity">
        <Spec
          rows={[
            ['Provider', provider && [provider.name, provider.location, provider.asn].filter(Boolean).join(' · ')],
            ['Zone', model.zoneById.get(n.zone)?.name],
            ['Site', siteNames(n)],
            ...Object.entries(n.addresses ?? {}).map(([k, v]): [string, string] => [k === 'wg' ? 'WireGuard' : k[0].toUpperCase() + k.slice(1), v]),
            ['OS', n.os],
            ['SSH', n.ssh && `ssh -p ${n.ssh.port ?? 22} ${n.ssh.user ? `${n.ssh.user}@` : ''}${n.host ?? n.addresses?.public ?? n.addresses?.lan ?? ''}`],
            ['Since', n.since],
          ]}
        />
      </Section>

      {n.hardware && (
        <Section title="Hardware">
          <Spec
            rows={[
              ['Model', n.hardware.model],
              ['CPU', n.hardware.cpu && `${n.hardware.cpu} vCPU${n.hardware.cpu_model ? ` · ${n.hardware.cpu_model}` : ''}`],
              ['Memory', n.hardware.memory_gib && `${n.hardware.memory_gib} GiB`],
              ['GPU', n.hardware.gpu],
              ['Disks', n.hardware.disks?.length ? <ul className="plain">{n.hardware.disks.map((d) => <li key={d}>{d}</li>)}</ul> : undefined],
            ]}
          />
        </Section>
      )}

      {usage && (
        <Section title={live ? `Usage · live ${new Date(live.at).toLocaleTimeString()} · ${live.plugin}` : `Usage${usage.sampled ? ` · sampled ${usage.sampled}` : ''}`}>
          <div className="insp__meters">
            <Meter label="cpu" pct={usage.cpu_pct} />
            <Meter label="mem" pct={usage.memory_pct} />
          </div>
          {usage.pods !== undefined && n.hardware?.max_pods && <PodGrid n={n} />}
          {pressure !== undefined && pressure >= 0.8 && (
            <p className="callout callout--notice">
              <span aria-hidden>▲</span> {Math.round(pressure * 100)}% of max_pods. New pods stop scheduling here at {n.hardware?.max_pods}, whatever the CPU says.
            </p>
          )}
        </Section>
      )}

      {n.runs?.length ? (
        <Section title="Runs">
          <ul className="tags">{n.runs.map((r) => <li key={r}>{r}</li>)}</ul>
        </Section>
      ) : null}

      {placements.length > 0 && (
        <Section title={`Apps here · ${placements.length}`}>
          <ul className="rows">
            {placements.map((p) => (
              <li key={p.app.id}>
                <button className="jump" onClick={() => ui.select({ type: 'app', id: p.app.id })}>
                  {p.app.name}
                </button>
                <span className="rows__meta">
                  {p.pods > 0 && `${p.pods} pods`}
                  {p.hosted && 'host'}
                  {p.databases.map((d) => (
                    <span key={d.name} className={d.nodes.length === 1 ? 'db db--solo' : 'db'}>
                      ◆ {d.name}
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {connections.length > 0 && (
        <Section title={`Connections · ${connections.length}`}>
          <ul className="rows">
            {connections.map((e) => {
              const out = covers(e.source, n.id)
              const other = out ? e.target : e.source
              return (
                <li key={e.id}>
                  <KindSwatch kind={e.kind} width={20} />
                  <span className="rows__dir">{out ? '→' : '←'}</span>
                  <Jump id={other}>{nameOf(other)}</Jump>
                  <span className="rows__meta">
                    {e.link.label ?? KINDS[e.kind].label}
                    {e.link.ports?.length ? ` · :${e.link.ports.join(', :')}` : ''}
                  </span>
                </li>
              )
            })}
          </ul>
        </Section>
      )}

      <Notes notes={notesOf(n.notes)} docs={n.docs} />
    </>
  )
}

function Notes({ notes, docs }: { notes: string[]; docs?: string[] }) {
  if (!notes.length && !docs?.length) return null
  return (
    <Section title="Notes">
      {notes.map((t) => (
        <p key={t} className="insp__note">
          {t}
        </p>
      ))}
      {docs?.map((d) => (
        <code key={d} className="insp__doc">
          {d}
        </code>
      ))}
    </Section>
  )
}

function AppDetail({ app }: { app: App }) {
  const ui = useUi()
  const solo = singleNodeDatabases(app)
  const pods = Object.entries(app.pods ?? {}).sort((a, b) => b[1] - a[1])
  const maxPods = Math.max(1, ...pods.map(([, v]) => v))

  return (
    <>
      <header className="insp__head">
        <span className="eyebrow">App · {app.category}</span>
        <h2>{app.name}</h2>
        {app.namespace && <p className="insp__host">{Array.isArray(app.namespace) ? `namespaces ${app.namespace.join(', ')}` : `namespace ${app.namespace}`}</p>}
        {ui.view !== 'topology' && (
          <button className="btn btn--primary" onClick={() => ui.setView('topology')}>
            Trace in topology
          </button>
        )}
      </header>

      {solo.length > 0 && (
        <p className="callout callout--notice">
          <span aria-hidden>▲</span> {solo.map((d) => `${d.name} only on ${nameOf(d.nodes[0])}`).join('; ')}. OpenEBS local volumes do not follow
          pods, so that data is offline while the node is.
        </p>
      )}

      {app.domains?.length ? (
        <Section title={`Domains · ${app.domains.length}`}>
          <ul className="tags tags--domains">{app.domains.map((d) => <li key={d}>{d}</li>)}</ul>
        </Section>
      ) : null}

      {(pods.length > 0 || app.host) && (
        <Section title="Runs on">
          <ul className="bars">
            {pods.map(([id, v]) => (
              <li key={id}>
                <Jump id={id}>{nameOf(id)}</Jump>
                <span className="bars__track">
                  <span className="bars__fill" style={{ width: `${(v / maxPods) * 100}%` }} />
                </span>
                <span className="bars__value">{v}</span>
              </li>
            ))}
            {app.host && (
              <li>
                <Jump id={app.host}>{nameOf(app.host)}</Jump>
                <span className="rows__meta">standalone host</span>
              </li>
            )}
          </ul>
        </Section>
      )}

      {app.databases?.length ? (
        <Section title="Data">
          <ul className="rows">
            {app.databases.map((d) => (
              <li key={d.name}>
                <span className={d.nodes.length === 1 ? 'db db--solo' : 'db'}>◆ {d.name}</span>
                <span className="rows__meta">
                  {d.engine} ·{' '}
                  {d.nodes.map((id, i) => (
                    <span key={id}>
                      {i > 0 && ', '}
                      <Jump id={id}>{nameOf(id)}</Jump>
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {(app.uses?.length || app.depends_on?.length) && (
        <Section title="Talks to">
          <ul className="tags">
            {app.uses?.map((id) => (
              <li key={id}>
                <Jump id={id}>{nameOf(id)}</Jump>
              </li>
            ))}
            {app.depends_on?.map((id) => (
              <li key={id}>
                <button className="jump" onClick={() => ui.select({ type: 'app', id })}>
                  {model.appById.get(id)?.name ?? id} (app)
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {app.analytics?.length ? <AppTraffic app={app} /> : null}

      {app.repos?.length ? <AppSecurity app={app} /> : null}

      <Notes notes={notesOf(app.notes)} />
    </>
  )
}

function AppTraffic({ app }: { app: App }) {
  const ui = useUi()
  const data = pickPeriod(useAnalytics(), ui.traffic.period)
  if (!data) return null
  const mine = data.results.filter((r) => r.app === app.id)
  const row = siteRows({ ...data, results: mine })[0]
  if (!row) return null
  const main = row.main
  const others = mine.filter((r) => r.ok && r.totals && r.provider !== 'search-console' && r.provider !== main?.provider)
  const s = row.search?.search
  return (
    <Section title={`Traffic · ${periodLabel(data).toLowerCase()}`}>
      {main?.totals && (
        <>
          <Spec
            rows={[
              ['Visitors', `${fmtFull(main.totals.visitors)}${main.previous?.visitors ? ` (${fmtFull(main.previous.visitors)} before)` : ''}`],
              ['Pageviews', main.totals.pageviews !== undefined ? fmtFull(main.totals.pageviews) : undefined],
              ['Source', main.parts ? `${PROVIDER_LABEL[main.provider]}, ${main.parts.length} sources added up` : `${PROVIDER_LABEL[main.provider]} ${main.id}`],
              // Other providers count the same visits, so they are not added in; shown to compare.
              ...[...new Set(others.map((r) => r.provider))].map((p): [string, string] => [
                'Also',
                `${PROVIDER_LABEL[p]}: ${fmtFull(others.filter((r) => r.provider === p).reduce((n, r) => n + (r.totals?.visitors ?? 0), 0))} visitors`,
              ]),
            ]}
          />
          {main.parts ? <BarList items={main.parts.map((p) => ({ key: p.allHosts?.[0]?.key ?? p.id, note: `${PROVIDER_LABEL[p.provider]} ${p.id}`, value: p.totals?.visitors ?? 0 }))} unit="visitors" label="Sites" /> : null}
          {main.series?.length ? <SeriesChart points={main.series.map((p) => ({ date: p.date, value: p.visitors ?? p.pageviews ?? 0 }))} unit="visitors" height={96} /> : null}
          {main.top?.pages?.length ? <BarList items={main.top.pages.slice(0, 5)} unit="views" label="Pages" /> : null}
        </>
      )}
      {s && (
        <>
          <Spec rows={[['Search', `${fmtFull(s.totals.clicks)} clicks, ${fmtFull(s.totals.impressions)} impressions, position ${s.totals.position.toFixed(1)}`]]} />
          <BarList items={s.queries.slice(0, 5).map((q) => ({ key: q.key, value: q.clicks }))} unit="clicks" label="Search queries" />
        </>
      )}
      {[...row.failed, ...mine.filter((r) => r.ok && r.note)].map((f) => (
        <p key={`${f.provider}:${f.id}`} className="callout callout--notice">
          {PROVIDER_LABEL[f.provider]} {f.id}: {f.ok ? f.note : f.error}
        </p>
      ))}
      <div className="tlinks">
        {mine
          .filter((r, i) => mine.findIndex((x) => sourceId(x) === sourceId(r)) === i)
          .map((r) => {
            const url = panelUrl(r, data.range)
            return url ? (
              <a key={sourceId(r)} className="tlink" href={url} target="_blank" rel="noopener noreferrer">
                {PROVIDER_LABEL[r.provider]} ↗
              </a>
            ) : null
          })}
      </div>
      <button className="btn" onClick={() => ui.openTraffic({ app: app.id, period: ui.traffic.period })}>
        All its traffic
      </button>
    </Section>
  )
}

function AppSecurity({ app }: { app: App }) {
  const ui = useUi()
  const scan = useScan()
  if (!scan) return null
  const repos = reposOf(scan, app.id)
  const scanned = repos.filter((r) => r.status === 'scanned')
  const counts = sumCounts(scanned, false)
  return (
    <Section title={`Dependencies · ${scanned.length} of ${repos.length} repos scanned`}>
      <div className="insp__sev">
        {SEVERITIES.filter((s) => counts[s]).map((s) => (
          <SeverityChip key={s} severity={s} count={counts[s]} />
        ))}
        {SEVERITIES.every((s) => !counts[s]) && <span className="rows__meta">No known vulnerabilities in what ships</span>}
      </div>
      <button className="btn" onClick={() => ui.setView('security')}>
        Open in Security
      </button>
    </Section>
  )
}

export function Inspector() {
  const ui = useUi()
  const sel = ui.selection
  const n = sel?.type === 'node' ? node(sel.id) : undefined
  const app = sel?.type === 'app' ? model.appById.get(sel.id) : undefined

  return (
    <AnimatePresence>
      {(n || app) && (
        <motion.aside
          key="inspector"
          className="insp"
          initial={{ x: 40, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 40, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 380, damping: 36 }}
        >
          <button className="insp__close" onClick={() => ui.select(null)} aria-label="Close">
            ×
          </button>
          <motion.div key={`${sel?.type}:${sel?.id}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
            {n ? <NodeDetail n={n} /> : app ? <AppDetail app={app} /> : null}
          </motion.div>
        </motion.aside>
      )}
    </AnimatePresence>
  )
}
