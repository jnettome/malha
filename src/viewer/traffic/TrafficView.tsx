import { model } from '../model/model.ts'
import { useUi } from '../ui/state.tsx'
import { BarList, Sparkline } from './charts.tsx'
import { delta, fmt, fmtFull, mergeTop, PROVIDER_LABEL, shortDate, siteRows, useAnalytics, type SiteRow } from './data.ts'

function Delta({ now, before }: { now?: number; before?: number }) {
  const d = delta(now, before)
  if (d.value === undefined) return <span className="delta">—</span>
  const up = d.value >= 0
  return (
    <span className={`delta${d.warn ? ' delta--warn' : ''}`} title={`${fmtFull(now)} against ${fmtFull(before)} the period before`}>
      {d.warn ? '⚠ ' : ''}
      {up ? '▲' : '▼'} {Math.abs(Math.round(d.value * 100))}%
    </span>
  )
}

function Tile({ label, now, before }: { label: string; now?: number; before?: number }) {
  return (
    <div className="tile">
      <span className="tile__label">{label}</span>
      <span className="tile__value">{fmt(now)}</span>
      <Delta now={now} before={before} />
    </div>
  )
}

function Row({ row }: { row: SiteRow }) {
  const ui = useUi()
  const app = model.appById.get(row.app)
  const main = row.main
  const s = row.search?.search
  const selected = ui.selection?.type === 'app' && ui.selection.id === row.app
  return (
    <button className={`tsite${selected ? ' is-selected' : ''}`} onClick={() => ui.select(selected ? null : { type: 'app', id: row.app })} role="row">
      <span className="tsite__name" role="cell">
        {app?.name ?? row.app}
        <span>{row.providers.map((p) => PROVIDER_LABEL[p]).join(' · ') || 'no source answered'}</span>
      </span>
      <span className="tsite__spark" role="cell">
        {main?.series?.length ? <Sparkline points={main.series.map((p) => ({ date: p.date, value: p.visitors ?? p.pageviews ?? 0 }))} unit="visitors" /> : <span className="rows__meta">—</span>}
      </span>
      <span className="tsite__num" role="cell">
        {fmt(main?.totals?.visitors)}
      </span>
      <span className="tsite__num" role="cell">
        <Delta now={main?.totals?.visitors} before={main?.previous?.visitors} />
      </span>
      <span className="tsite__num tsite__wide" role="cell">
        {fmt(main?.totals?.pageviews)}
      </span>
      <span className="tsite__num tsite__wide" role="cell">
        {s ? fmt(s.totals.clicks) : '—'}
      </span>
      <span className="tsite__num tsite__wide" role="cell">
        {s ? s.totals.position.toFixed(1) : '—'}
      </span>
    </button>
  )
}

export function TrafficView() {
  const data = useAnalytics()
  if (data === undefined) return <div className="traffic" />
  if (!data) {
    return (
      <div className="traffic">
        <div className="page-intro">
          <span className="eyebrow eyebrow--accent">Traffic</span>
          <h1>No traffic yet</h1>
          <p>
            Every site's visitors and search, from Umami, Google Analytics, PostHog and Search Console, in one place. Add the plugins you use (<code>malha plugin add umami</code>,{' '}
            <code>google</code>, <code>posthog</code>), let <code>malha analytics detect</code> find which app has which tracker, then run <code>malha analytics refresh</code>.
          </p>
        </div>
      </div>
    )
  }
  const rows = siteRows(data)
  const sum = (pick: (r: SiteRow) => number | undefined) => rows.reduce((n, r) => n + (pick(r) ?? 0), 0)
  const has = (pick: (r: SiteRow) => number | undefined) => rows.some((r) => pick(r) !== undefined)
  const visitors = sum((r) => r.main?.totals?.visitors)
  const searchRows = rows.filter((r) => r.search?.search)
  const queries = searchRows
    .flatMap((r) => r.search!.search!.queries.map((q) => ({ key: q.key, value: q.clicks, note: model.appById.get(r.app)?.name ?? r.app })))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10)
  const referrers = mergeTop(rows.map((r) => r.main?.top?.referrers ?? []))
  const pages = rows.flatMap((r) => (r.main?.top?.pages ?? []).slice(0, 3).map((p) => ({ key: p.key, value: p.value, note: model.appById.get(r.app)?.name ?? r.app }))).sort((a, b) => b.value - a.value).slice(0, 8)
  const failed = rows.flatMap((r) => r.failed)
  return (
    <div className="traffic">
      <div className="page-intro">
        <span className="eyebrow eyebrow--accent">Traffic</span>
        <h1>
          {fmtFull(visitors)} visitors across {rows.filter((r) => r.main).length} sites in {data.days} days
        </h1>
        <p>
          {shortDate(data.range.from)} to {shortDate(data.range.to)}, against the {data.days} days before. Each site counts its main source; visitors are summed across sites, so
          someone who visits two counts twice. Fetched {new Date(data.fetched).toLocaleString()}; <code>malha analytics refresh</code> updates it.
        </p>
      </div>

      <div className="tiles">
        <Tile label="Visitors" now={visitors} before={sum((r) => r.main?.previous?.visitors)} />
        {has((r) => r.main?.totals?.pageviews) && <Tile label="Pageviews" now={sum((r) => r.main?.totals?.pageviews)} before={sum((r) => r.main?.previous?.pageviews)} />}
        {searchRows.length > 0 && <Tile label="Search clicks" now={sum((r) => r.search?.search?.totals.clicks)} before={sum((r) => r.search?.search?.previous?.clicks)} />}
        {searchRows.length > 0 && <Tile label="Search impressions" now={sum((r) => r.search?.search?.totals.impressions)} before={sum((r) => r.search?.search?.previous?.impressions)} />}
      </div>

      <section className="tsites" role="table" aria-label="Traffic by site">
        <div className="tsite tsite--head" role="row">
          <span role="columnheader">Site</span>
          <span role="columnheader">Visitors per day</span>
          <span className="tsite__num" role="columnheader">
            Visitors
          </span>
          <span className="tsite__num" role="columnheader">
            Change
          </span>
          <span className="tsite__num tsite__wide" role="columnheader">
            Pageviews
          </span>
          <span className="tsite__num tsite__wide" role="columnheader">
            Search clicks
          </span>
          <span className="tsite__num tsite__wide" role="columnheader">
            Position
          </span>
        </div>
        {rows.map((r) => (
          <Row key={r.app} row={r} />
        ))}
      </section>

      <div className="traffic__grid">
        {queries.length > 0 && (
          <section className="tpanel">
            <h2 className="eyebrow">Top search queries · clicks</h2>
            <BarList items={queries} unit="clicks" label="Search queries" />
          </section>
        )}
        <section className="tpanel">
          <h2 className="eyebrow">Where visitors come from</h2>
          <BarList items={referrers} unit="visits" label="Referrers" />
        </section>
        <section className="tpanel">
          <h2 className="eyebrow">Busiest pages</h2>
          <BarList items={pages} unit="views" label="Pages" />
        </section>
      </div>

      {failed.length > 0 && (
        <section className="tpanel tpanel--notice">
          <h2 className="eyebrow">Could not read · {failed.length}</h2>
          <ul className="plain">
            {failed.map((f) => (
              <li key={`${f.app}:${f.provider}:${f.id}`}>
                <b>{model.appById.get(f.app)?.name ?? f.app}</b> · {PROVIDER_LABEL[f.provider]} {f.id}: {f.error}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
