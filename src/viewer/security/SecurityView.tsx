import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { apps } from '../model/model.ts'
import type { App } from '../../core/types.ts'
import { useUi } from '../ui/state.tsx'
import {
  advisoryUrl,
  countTotal,
  hotPackages,
  reposOf,
  SEVERITY_LABEL,
  shortRepo,
  sumCounts,
  useScan,
  visibleFindings,
} from './security.ts'
import type { Finding, RepoScan, SecurityScan, Severity } from '../../core/security.ts'
import { SEVERITIES } from '../../core/security.ts'

const FINDINGS_PREVIEW = 25
const BAR_SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low']

export function SeverityChip({ severity, count }: { severity: Severity; count?: number }) {
  return (
    <span className={`sev sev--${severity}`}>
      <i aria-hidden />
      {count !== undefined && <b>{count}</b>}
      {SEVERITY_LABEL[severity]}
    </span>
  )
}

/** Counts by severity as one bar: its length is the app's total against the largest app. */
function SeverityBar({ counts, max }: { counts: Record<Severity, number>; max: number }) {
  const total = BAR_SEVERITIES.reduce((n, s) => n + counts[s], 0)
  return (
    <span className="sevbar" role="img" aria-label={BAR_SEVERITIES.map((s) => `${counts[s]} ${s}`).join(', ')}>
      <span className="sevbar__fill" style={{ width: `${(total / max) * 100}%` }}>
        {BAR_SEVERITIES.map((s) => (counts[s] ? <i key={s} className={`sevbar__seg sevbar__seg--${s}`} style={{ flexGrow: counts[s] }} /> : null))}
      </span>
    </span>
  )
}

function FindingRow({ f }: { f: Finding }) {
  const [id, ...aliases] = f.ids
  return (
    <div className="finding" role="row">
      <span role="cell">
        <SeverityChip severity={f.severity} />
      </span>
      <span className="finding__pkg" role="cell">
        {f.package}
        <span>@{f.version}</span>
        {f.dev && <em>dev</em>}
      </span>
      <span className="finding__summary" role="cell">
        {f.summary || '—'}
      </span>
      <span className="finding__ids" role="cell">
        <a href={advisoryUrl(id)} target="_blank" rel="noreferrer">
          {id}
        </a>
        {aliases.length > 0 && <span title={aliases.join(', ')}> +{aliases.length}</span>}
      </span>
      <span className="finding__fix" role="cell">
        {f.fixed ? `→ ${f.fixed}` : 'no fix yet'}
      </span>
      <span className="finding__lock" role="cell">
        {f.lockfile}
      </span>
    </div>
  )
}

function RepoCard({ r, dev, codeDir }: { r: RepoScan; dev: boolean; codeDir: string }) {
  const [all, setAll] = useState(false)
  const findings = visibleFindings(r, dev)
  const counts = sumCounts([r], dev)
  return (
    <div className="repo">
      <header className="repo__head">
        <span className="repo__name">{shortRepo(r.repo)}</span>
        <span className="repo__meta">
          {r.local && <>{codeDir}/{r.local} · </>}
          {r.ref}@{r.commit} · {r.committed}
          {r.fetched === false && ' · not fetched'}
        </span>
        <span className="repo__counts">
          {SEVERITIES.filter((s) => counts[s]).map((s) => (
            <SeverityChip key={s} severity={s} count={counts[s]} />
          ))}
          {countTotal(counts) === 0 && <span className="repo__clean">No known vulnerabilities</span>}
        </span>
      </header>
      <p className="repo__lockfiles">
        {r.lockfiles.join(', ')}
        {r.skipped.length > 0 && ` · not readable: ${r.skipped.join(', ')}`}
        {r.message && ` · ${r.message}`}
      </p>
      {findings.length > 0 && (
        <div className="findings" role="table">
          {(all ? findings : findings.slice(0, FINDINGS_PREVIEW)).map((f, i) => (
            <FindingRow key={`${f.lockfile}|${f.package}|${f.ids[0]}|${i}`} f={f} />
          ))}
          {findings.length > FINDINGS_PREVIEW && (
            <button className="btn btn--ghost findings__more" onClick={() => setAll((a) => !a)}>
              {all ? 'Show fewer' : `Show all ${findings.length}`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function AppRow({ scan, app, dev, max, open, toggle }: { scan: SecurityScan; app: App; dev: boolean; max: number; open: boolean; toggle: () => void }) {
  const repos = reposOf(scan, app.id)
  const scanned = repos.filter((r) => r.status === 'scanned')
  const counts = sumCounts(scanned, dev)
  const missing = repos.length - scanned.length
  return (
    <div className={`secapp${open ? ' is-open' : ''}`}>
      <button className="secapp__row" onClick={toggle} aria-expanded={open}>
        <span className="secapp__name">
          {app.name}
          <span>
            {scanned.length} of {repos.length} repo{repos.length > 1 ? 's' : ''} scanned
          </span>
        </span>
        <SeverityBar counts={counts} max={max} />
        <span className="secapp__counts">
          {BAR_SEVERITIES.map((s) => (
            <span key={s} className={`secapp__n${counts[s] ? '' : ' is-zero'}`} title={SEVERITY_LABEL[s]}>
              <i className={`dot dot--${s}`} aria-hidden />
              {counts[s]}
            </span>
          ))}
        </span>
        <span className="secapp__chev" aria-hidden>
          {open ? '−' : '+'}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="secapp__body" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
            {missing > 0 && (
              <p className="secapp__missing">
                Not scanned: {repos.filter((r) => r.status !== 'scanned').map((r) => `${shortRepo(r.repo)} (${r.status})`).join(', ')}
              </p>
            )}
            {scanned.map((r) => (
              <RepoCard key={r.repo} r={r} dev={dev} codeDir={scan.codeDir ?? '…'} />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export function SecurityView() {
  const ui = useUi()
  const [dev, setDev] = useState(false)
  const [open, setOpen] = useState<string | null>(ui.selection?.type === 'app' ? ui.selection.id : null)
  const scan = useScan()

  if (scan === undefined) return <div className="security" />
  if (!scan) {
    return (
      <div className="security">
        <div className="page-intro">
          <span className="eyebrow eyebrow--accent">Security</span>
          <h1>No scan yet</h1>
          <p>
            Run <code>malha scan --code-dir &lt;folder with your clones&gt;</code>. It reads the lockfiles of every repo listed under an app's{' '}
            <code>repos</code> and writes <code>.malha/scan.json</code> next to the topology file, which this page shows.
          </p>
        </div>
      </div>
    )
  }

  const scannedRepos = scan.repos.filter((r) => r.status === 'scanned')
  const total = sumCounts(scannedRepos, dev)
  const ranked = apps
    .filter((a) => a.repos?.length)
    .map((a) => ({ app: a, counts: sumCounts(reposOf(scan, a.id).filter((r) => r.status === 'scanned'), dev) }))
    .sort((a, b) => b.counts.critical - a.counts.critical || b.counts.high - a.counts.high || countTotal(b.counts) - countTotal(a.counts))
  const max = Math.max(1, ...ranked.map((r) => countTotal(r.counts)))
  const hot = hotPackages(scan, 'critical', dev).slice(0, 10)
  const unscanned = scan.repos.filter((r) => r.status !== 'scanned')
  const findings = scannedRepos.flatMap((r) => visibleFindings(r, dev))
  const fixable = findings.length ? Math.round((findings.filter((f) => f.fixed).length / findings.length) * 100) : 100
  const when = new Date(scan.scanned)

  return (
    <div className="security">
      <div className="page-intro">
        <span className="eyebrow eyebrow--accent">Security</span>
        <h1>
          {total.critical} critical and {total.high} high advisories in what ships
        </h1>
        <p>
          {scannedRepos.length} of {scan.repos.length} repos scanned on {when.toISOString().slice(0, 10)} at {when.toISOString().slice(11, 16)} UTC with{' '}
          {scan.tool} ({scan.mode === 'online' ? 'api.osv.dev' : 'offline databases'}). Lockfiles are read from each repo's remote default branch. Each
          package and advisory is counted once per repo. {fixable}% of findings have a fixed version. Refresh with <code>malha scan</code>.
        </p>
      </div>

      <div className="tiles">
        {SEVERITIES.filter((s) => s !== 'unknown' || total.unknown > 0).map((s, i) => (
          <motion.div key={s} className="tile" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
            <span className="tile__label">
              <i className={`dot dot--${s}`} aria-hidden /> {SEVERITY_LABEL[s]}
            </span>
            <span className="tile__value">{total[s]}</span>
          </motion.div>
        ))}
      </div>

      <div className="filters">
        <label className="layer">
          <input type="checkbox" checked={dev} onChange={(e) => setDev(e.target.checked)} />
          <span>Include dev-only dependencies</span>
        </label>
        <span className="filters__legend">
          {BAR_SEVERITIES.map((s) => (
            <SeverityChip key={s} severity={s} />
          ))}
        </span>
      </div>

      {hot.length > 0 && (
        <section className="hot">
          <h2 className="eyebrow">Fix these first: critical, by how many repos carry them</h2>
          <div className="hot__list">
            {hot.map((h) => (
              <div key={`${h.ecosystem}|${h.package}`} className="hot__row" title={h.repos.map(shortRepo).join('\n')}>
                <span className="hot__pkg">
                  {h.package}
                  <span>{h.ecosystem}</span>
                </span>
                <span className="hot__repos">
                  {h.repos.length} repo{h.repos.length > 1 ? 's' : ''}
                </span>
                <span className="hot__fix">
                  {h.fixes.length === 0 ? 'no fix yet' : h.fixes.length === 1 ? `fixed in ${h.fixes[0]}` : `fixed in ${h.fixes[0]} … ${h.fixes.at(-1)}`}
                </span>
                <span className="hot__summary">{h.summary}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="secapps">
        <h2 className="eyebrow">By app</h2>
        {ranked.map(({ app }) => (
          <AppRow key={app.id} scan={scan} app={app} dev={dev} max={max} open={open === app.id} toggle={() => setOpen(open === app.id ? null : app.id)} />
        ))}
      </section>

      {unscanned.length > 0 && (
        <section className="unscanned">
          <h2 className="eyebrow">Not scanned</h2>
          {unscanned.map((r) => (
            <p key={r.repo}>
              <span className="repo__name">{shortRepo(r.repo)}</span> ({r.apps.join(', ')}): {r.message ?? r.status}
              {r.status === 'not-cloned' && (
                <code>
                  git clone git@{r.repo.replace('/', ':')}.git {scan.codeDir ?? '.'}/{r.repo.split('/').at(-1)}
                </code>
              )}
            </p>
          ))}
        </section>
      )}
    </div>
  )
}
