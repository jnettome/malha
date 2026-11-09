import { useState } from 'react'
import { isRelative, pickPeriod, type AnalyticsCache, type DateRange } from '../../core/analytics.ts'
import { model } from '../model/model.ts'
import { useUi } from '../ui/state.tsx'
import { BarList, CompareChart, Sparkline } from './charts.tsx'
import { addSeries, canFetchRanges, fmt, fmtFull, mergeTop, tidy, periodLabel, previousLabel, PROVIDER_LABEL, shortDate, siteRows, useAnalytics, type SiteRow } from './data.ts'
import { Delta, Tile } from './parts.tsx'
import { PeriodPicker } from './PeriodPicker.tsx'
import { SiteView } from './SiteView.tsx'

function Row({ row, period }: { row: SiteRow; period: string | undefined }) {
  const ui = useUi()
  const app = model.appById.get(row.app)
  const main = row.main
  const s = row.search?.search
  return (
    <a
      className="tsite"
      href={`#traffic/${encodeURIComponent(row.app)}${period ? `?p=${encodeURIComponent(period)}` : ''}`}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return
        e.preventDefault()
        ui.openTraffic({ app: row.app, period })
      }}
      role="row"
    >
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
    </a>
  )
}

/** "in the last 30 days", or "from Sep 1 to Sep 30" */
const inPeriod = (p: AnalyticsCache) => (isRelative(p.key) ? `in the last ${p.days} days` : `from ${shortDate(p.range.from)} to ${shortDate(p.range.to)}`)

export function TrafficView() {
  const ui = useUi()
  const file = useAnalytics()
  const [picked, setPicked] = useState<DateRange>()
  if (file === undefined) return <div className="traffic" />
  const data = pickPeriod(file, ui.traffic.period)
  if (!file || !data) {
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
  if (ui.traffic.app) return <SiteView file={file} data={data} app={ui.traffic.app} picked={picked} onPick={setPicked} />

  const rows = siteRows(data)
  const sum = (pick: (r: SiteRow) => number | undefined) => rows.reduce((n, r) => n + (pick(r) ?? 0), 0)
  const has = (pick: (r: SiteRow) => number | undefined) => rows.some((r) => pick(r) !== undefined)
  const visitors = sum((r) => r.main?.totals?.visitors)
  const measured = rows.filter((r) => r.main)
  const searchRows = rows.filter((r) => r.search?.search)
  const name = (app: string) => model.appById.get(app)?.name ?? app
  const queries = searchRows
    .flatMap((r) => r.search!.search!.queries.map((q) => ({ key: q.key, value: q.clicks, note: name(r.app) })))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10)
  const top = (list: 'referrers' | 'countries' | 'devices', limit = 8) => mergeTop(rows.map((r) => tidy(list, r.main?.top?.[list] ?? [])), limit)
  const pages = rows.flatMap((r) => (r.main?.top?.pages ?? []).slice(0, 3).map((p) => ({ key: p.key, value: p.value, note: name(r.app) }))).sort((a, b) => b.value - a.value).slice(0, 8)
  const failed = rows.flatMap((r) => r.failed)
  const noted = data.results.filter((r) => r.ok && r.note)
  const value = (p: { visitors?: number; pageviews?: number }) => p.visitors ?? p.pageviews
  const daily = addSeries(measured.map((r) => r.main!.series), value)
  // The comparison line only when every site has one; a partial sum would look like a drop.
  const before = measured.every((r) => r.main!.previousSeries) ? addSeries(measured.map((r) => r.main!.previousSeries), value) : undefined
  return (
    <div className="traffic">
      <div className="page-intro">
        <span className="eyebrow eyebrow--accent">Traffic</span>
        <h1>
          {fmtFull(visitors)} visitors across {measured.length} sites {inPeriod(data)}
        </h1>
        <p>
          {periodLabel(data)} ({shortDate(data.range.from)} to {shortDate(data.range.to)}), against {previousLabel(data)}. Each site counts its main source; visitors are summed across
          sites, so someone who visits two counts twice. Fetched {new Date(data.fetched).toLocaleString()}; <code>malha analytics refresh</code> updates it.
        </p>
      </div>

      <PeriodPicker file={file} current={data} selection={picked} />

      <div className="tiles">
        <Tile label="Visitors" now={visitors} before={sum((r) => r.main?.previous?.visitors)} />
        {has((r) => r.main?.totals?.pageviews) && <Tile label="Pageviews" now={sum((r) => r.main?.totals?.pageviews)} before={sum((r) => r.main?.previous?.pageviews)} />}
        {searchRows.length > 0 && <Tile label="Search clicks" now={sum((r) => r.search?.search?.totals.clicks)} before={sum((r) => r.search?.search?.previous?.clicks)} />}
        {searchRows.length > 0 && <Tile label="Search impressions" now={sum((r) => r.search?.search?.totals.impressions)} before={sum((r) => r.search?.search?.previous?.impressions)} />}
      </div>

      {daily.length > 1 && (
        <section className="tpanel tpanel--chart">
          <h2 className="eyebrow">Visitors per day, all sites</h2>
          <CompareChart now={daily} before={before} unit="visitors" labels={[periodLabel(data), previousLabel(data)]} totals={[visitors, before ? sum((r) => r.main?.previous?.visitors) : undefined]} onSelect={canFetchRanges() ? (from, to) => setPicked({ from, to }) : undefined} />
        </section>
      )}

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
          <Row key={r.app} row={r} period={ui.traffic.period} />
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
          <BarList items={top('referrers')} unit="visits" label="Referrers" />
        </section>
        <section className="tpanel">
          <h2 className="eyebrow">Busiest pages</h2>
          <BarList items={pages} unit="views" label="Pages" />
        </section>
        <section className="tpanel">
          <h2 className="eyebrow">Countries</h2>
          <BarList items={top('countries')} unit="visitors" label="Countries" />
        </section>
        <section className="tpanel">
          <h2 className="eyebrow">Devices</h2>
          <BarList items={top('devices', 5)} unit="visitors" label="Devices" />
        </section>
      </div>

      {failed.length + noted.length > 0 && (
        <section className="tpanel tpanel--notice">
          <h2 className="eyebrow">{noted.length === 0 ? 'Could not read' : failed.length === 0 ? 'Worth a look' : 'Needs a look'} · {failed.length + noted.length}</h2>
          <ul className="plain">
            {[...failed, ...noted].map((f) => (
              <li key={`${f.app}:${f.provider}:${f.id}`}>
                <b>{name(f.app)}</b> · {PROVIDER_LABEL[f.provider]} {f.id}: {f.ok ? f.note : f.error}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
