import { useState } from 'react'
import { mainResult, panelUrl, sourceId, type AnalyticsCache, type AnalyticsFile, type DateRange, type SearchQuery, type SourceResult, type TopList } from '../../core/analytics.ts'
import { model } from '../model/model.ts'
import { useUi } from '../ui/state.tsx'
import { BarList, CompareChart } from './charts.tsx'
import { canFetchRanges, duration, fmtFull, pct, tidy, periodLabel, previousLabel, PROVIDER_LABEL, shortDate } from './data.ts'
import { Tile } from './parts.tsx'
import { PeriodPicker } from './PeriodPicker.tsx'

const LISTS: { list: TopList; title: string; unit: string }[] = [
  { list: 'pages', title: 'Pages', unit: 'views' },
  { list: 'referrers', title: 'Where visitors come from', unit: 'visits' },
  { list: 'countries', title: 'Countries', unit: 'visitors' },
  { list: 'devices', title: 'Devices', unit: 'visitors' },
  { list: 'browsers', title: 'Browsers', unit: 'visitors' },
  { list: 'os', title: 'Operating systems', unit: 'visitors' },
]

/** A link to the source's own dashboard, for the period on screen. */
function PanelLink({ source, period, label }: { source: SourceResult; period: AnalyticsCache; label?: string }) {
  const url = panelUrl(source, period.range)
  if (!url) return null
  return (
    <a className="tlink" href={url} target="_blank" rel="noopener noreferrer">
      {label ?? `${PROVIDER_LABEL[source.provider]} ${source.id}`} ↗
    </a>
  )
}

function SearchTable({ rows, label }: { rows: SearchQuery[]; label: string }) {
  if (!rows.length) return <p className="tbars__empty">No {label.toLowerCase()} in this period.</p>
  return (
    <div className="table-wrap">
      <table className="matrix matrix--static">
        <thead>
          <tr>
            <th>{label}</th>
            <th className="num">Clicks</th>
            <th className="num ttable__wide">Impressions</th>
            <th className="num ttable__wide">CTR</th>
            <th className="num">Position</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((q) => (
            <tr key={q.key}>
              <td className="ttable__key" title={q.key}>
                {q.key.replace(/^https?:\/\/[^/]+/, '') || '/'}
              </td>
              <td className="num">{fmtFull(q.clicks)}</td>
              <td className="num ttable__wide">{fmtFull(q.impressions)}</td>
              <td className="num ttable__wide">{pct(q.ctr)}</td>
              <td className="num">{q.position.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** One site's traffic: every number Malha has for it in the period, against the period before. */
export function SiteView({ file, data, app, picked, onPick }: { file: AnalyticsFile; data: AnalyticsCache; app: string; picked?: DateRange; onPick: (r: DateRange) => void }) {
  const select = canFetchRanges() ? (from: string, to: string) => onPick({ from, to }) : undefined
  const ui = useUi()
  const [metric, setMetric] = useState<'visitors' | 'pageviews'>('visitors')
  const name = model.appById.get(app)?.name ?? app
  const domains = model.appById.get(app)?.domains ?? []
  const mine = data.results.filter((r) => r.app === app)
  const main = mainResult(mine)
  const sc = mine.find((r) => r.provider === 'search-console' && r.ok && r.search)
  const s = sc?.search
  const others = mine.filter((r) => r.ok && r.totals && r.provider !== 'search-console' && r.provider !== main?.provider)
  const notices = [...mine.filter((r) => !r.ok), ...mine.filter((r) => r.ok && r.note)]
  const sources = mine.filter((r, i) => mine.findIndex((x) => sourceId(x) === sourceId(r)) === i)
  const back = `#traffic${ui.traffic.period ? `?p=${encodeURIComponent(ui.traffic.period)}` : ''}`
  const t = main?.totals
  const p = main?.previous
  const perVisit = (x: typeof t) => (x?.pageviews !== undefined && x.sessions ? x.pageviews / x.sessions : undefined)
  const pick = (pt: { visitors?: number; pageviews?: number }) => (metric === 'visitors' ? (pt.visitors ?? 0) : (pt.pageviews ?? 0))

  return (
    <div className="traffic">
      <div className="page-intro">
        <a
          className="tback"
          href={back}
          onClick={(e) => {
            e.preventDefault()
            ui.openTraffic({ period: ui.traffic.period })
          }}
        >
          ← All sites
        </a>
        <span className="eyebrow eyebrow--accent">Traffic</span>
        <h1>{name}</h1>
        <p>
          {domains.filter((d) => !d.includes('*')).slice(0, 4).join(', ')}
          {domains.length > 4 ? ` and ${domains.length - 4} more` : ''}. {periodLabel(data)} ({shortDate(data.range.from)} to {shortDate(data.range.to)}), against {previousLabel(data)}.
        </p>
        <div className="tlinks">
          <span className="tlinks__label">Open in</span>
          {sources.map((r) => (
            <PanelLink key={sourceId(r)} source={r} period={data} />
          ))}
          <button className="btn btn--ghost" onClick={() => ui.select({ type: 'app', id: app })}>
            Show its machines
          </button>
        </div>
      </div>

      <PeriodPicker file={file} current={data} selection={picked} />

      {!mine.length && <p className="callout callout--notice">{name} has no analytics source in this period.</p>}

      {main && t && (
        <>
          <div className="tiles">
            <Tile label="Visitors" now={t.visitors} before={p?.visitors} />
            <Tile label="Pageviews" now={t.pageviews} before={p?.pageviews} warn={false} />
            {t.sessions !== undefined && <Tile label="Sessions" now={t.sessions} before={p?.sessions} warn={false} />}
            {perVisit(t) !== undefined && <Tile label="Pages per visit" now={perVisit(t)} before={perVisit(p)} shown={perVisit(t)!.toFixed(1)} warn={false} />}
            {t.bounce_rate !== undefined && <Tile label="Bounce rate" now={t.bounce_rate} shown={pct(t.bounce_rate, 0)} note={p?.bounce_rate !== undefined ? `${pct(p.bounce_rate, 0)} before` : ''} />}
            {t.avg_duration !== undefined && <Tile label="Visit length" now={t.avg_duration} shown={duration(t.avg_duration)} note={p?.avg_duration !== undefined ? `${duration(p.avg_duration)} before` : ''} />}
          </div>

          {main.series && main.series.length > 1 && (
            <section className="tpanel tpanel--chart">
              <div className="tpanel__head">
                <h2 className="eyebrow">{metric === 'visitors' ? 'Visitors' : 'Pageviews'} per day</h2>
                <div className="segmented" role="group" aria-label="Measure">
                  {(['visitors', 'pageviews'] as const).map((m) => (
                    <button key={m} className={m === metric ? 'is-active' : ''} aria-pressed={m === metric} onClick={() => setMetric(m)}>
                      {m}
                    </button>
                  ))}
                </div>
              </div>
              <CompareChart
                now={main.series.map((pt) => ({ date: pt.date, value: pick(pt) }))}
                before={main.previousSeries?.map((pt) => ({ date: pt.date, value: pick(pt) }))}
                unit={metric}
                labels={[periodLabel(data), previousLabel(data)]}
                onSelect={select}
                totals={metric === 'visitors' ? [t.visitors, p?.visitors] : [t.pageviews, p?.pageviews]}
              />
            </section>
          )}

          {main.parts && (
            <section className="tpanel">
              <h2 className="eyebrow">
                Sites · {PROVIDER_LABEL[main.provider]}, {main.parts.length} sources added up
              </h2>
              <BarList items={main.parts.map((r) => ({ key: r.allHosts?.[0]?.key ?? r.id, note: `${PROVIDER_LABEL[r.provider]} ${r.id}`, value: r.totals?.visitors ?? 0 }))} unit="visitors" label="Sites" />
            </section>
          )}

          <div className="traffic__grid">
            {LISTS.map(({ list, title, unit }) => (
              <section key={list} className="tpanel">
                <h2 className="eyebrow">{title}</h2>
                <BarList items={tidy(list, main.top?.[list] ?? []).slice(0, 10)} unit={unit} label={title} />
              </section>
            ))}
          </div>

          {others.length > 0 && (
            <section className="tpanel">
              <h2 className="eyebrow">Also measured by</h2>
              <p className="tpanel__lede">Other providers count the same visits their own way, so they are not added in. A big gap usually means one of them misses some pages.</p>
              <ul className="plain">
                {others.map((r) => (
                  <li key={sourceId(r)}>
                    <b>
                      {PROVIDER_LABEL[r.provider]} {r.id}
                    </b>
                    : {fmtFull(r.totals?.visitors)} visitors, {fmtFull(r.totals?.pageviews)} pageviews (here: {fmtFull(t.visitors)} and {fmtFull(t.pageviews)}) <PanelLink source={r} period={data} label="Open" />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {s && sc && (
        <>
          <div className="tsection">
            <h2>Search</h2>
            <PanelLink source={sc} period={data} label={`Search Console ${sc.id}`} />
          </div>
          <div className="tiles">
            <Tile label="Clicks" now={s.totals.clicks} before={s.previous?.clicks} />
            <Tile label="Impressions" now={s.totals.impressions} before={s.previous?.impressions} warn={false} />
            <Tile label="Click rate" now={s.totals.ctr} shown={pct(s.totals.ctr)} note={s.previous ? `${pct(s.previous.ctr)} before` : ''} />
            <Tile label="Average position" now={s.totals.position} shown={s.totals.position.toFixed(1)} note={s.previous ? `${s.previous.position.toFixed(1)} before; lower is better` : ''} />
          </div>
          {s.series.length > 1 && (
            <section className="tpanel tpanel--chart">
              <h2 className="eyebrow">Search clicks per day</h2>
              <CompareChart
                now={s.series.map((pt) => ({ date: pt.date, value: pt.clicks }))}
                before={s.previousSeries?.map((pt) => ({ date: pt.date, value: pt.clicks }))}
                unit="clicks"
                labels={[periodLabel(data), previousLabel(data)]}
                onSelect={select}
                totals={[s.totals.clicks, s.previous?.clicks]}
              />
            </section>
          )}
          <div className="traffic__grid traffic__grid--wide">
            <section className="tpanel">
              <h2 className="eyebrow">Queries</h2>
              <SearchTable rows={s.queries} label="Query" />
            </section>
            <section className="tpanel">
              <h2 className="eyebrow">Pages in search</h2>
              <SearchTable rows={s.pages} label="Page" />
            </section>
          </div>
        </>
      )}

      {notices.length > 0 && (
        <section className="tpanel tpanel--notice">
          <h2 className="eyebrow">Needs a look · {notices.length}</h2>
          <ul className="plain">
            {notices.map((r) => (
              <li key={sourceId(r)}>
                <b>
                  {PROVIDER_LABEL[r.provider]} {r.id}
                </b>
                : {r.ok ? r.note : r.error}
              </li>
            ))}
          </ul>
        </section>
      )}
      {!main && !s && mine.length > 0 && <p className="tbars__empty">No numbers for {name} in this period.</p>}
    </div>
  )
}
