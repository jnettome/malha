import { primaryResult, type AnalyticsCache } from './analytics.ts'
import type { LiveNode } from './live.ts'
import type { SecurityScan, Severity } from './security.ts'
import type { Topology } from './types.ts'
import { daysUntil, domainUsers } from './validate.ts'

// `malha check`: what in the map needs a person. Each finding has a stable id, so it can be
// accepted in topology.yaml or announced once, and a level, so it is announced again when it
// gets worse (a domain at 30 days, then 14, 7, and expired).

export const CHECKS = [
  'domain-expiry',
  'domain-untracked',
  'domain-no-autorenew',
  'domain-unlisted',
  'node-degraded',
  'pod-pressure',
  'single-node-database',
  'vulnerability',
  'scan-stale',
  'traffic-drop',
  'analytics-error',
  'analytics-stale',
] as const
export type CheckName = (typeof CHECKS)[number]

export interface CheckFinding {
  /** `<check>:<subject>`, stable from run to run. */
  id: string
  check: CheckName
  /** What it is about: a domain, a node id, `app/database`, an advisory id. */
  subject: string
  severity: 'critical' | 'warning'
  /** Rises as it gets worse; a new level is announced again. */
  level: string
  title: string
  detail?: string
  /** How many places it affects (repos, for a vulnerability); more sorts first. */
  count?: number
}

/** Findings grouped for people: the order to show them in. */
export const AREAS: { name: string; checks: CheckName[] }[] = [
  { name: 'Domains', checks: ['domain-expiry', 'domain-untracked', 'domain-no-autorenew', 'domain-unlisted'] },
  { name: 'Nodes', checks: ['node-degraded', 'pod-pressure'] },
  { name: 'Databases', checks: ['single-node-database'] },
  { name: 'Dependencies', checks: ['scan-stale', 'vulnerability'] },
  { name: 'Traffic', checks: ['analytics-stale', 'analytics-error', 'traffic-drop'] },
]

export const areaOf = (f: CheckFinding) => AREAS.find((a) => a.checks.includes(f.check))!.name

export interface Accepted {
  check: CheckName
  /** Omit to accept every finding of that check. */
  subject?: string
  why: string
  /** YYYY-MM-DD; after it the finding is open again. */
  until?: string
}

export interface CheckOptions {
  today?: Date
  scan?: SecurityScan | null
  /** Live node data, from `--live`; it wins over the sampled usage and status. */
  live?: Record<string, LiveNode>
  /** Vulnerability severities to report. */
  severities?: Severity[]
  /** The last `malha analytics refresh`. */
  analytics?: AnalyticsCache | null
}

export const PRESSURE = { warning: 0.8, critical: 0.95 }
export const SCAN_STALE_DAYS = 14
/** A drop this big against the previous period is a warning, and the second a critical finding. */
export const TRAFFIC_DROP = { warning: 0.5, critical: 0.8 }
/** Fewer visitors (or clicks) than this in the previous period is too little to judge a drop. */
export const TRAFFIC_BASELINE = 50
export const ANALYTICS_STALE_DAYS = 3

const finding = (check: CheckName, subject: string, f: Omit<CheckFinding, 'id' | 'check' | 'subject'>): CheckFinding => ({ id: `${check}:${subject}`, check, subject, ...f })

function domains(t: Topology, today: Date) {
  const out: CheckFinding[] = []
  if (!t.domains) return out
  const usedBy = domainUsers(t)
  const listed = new Set(t.domains.list.map((d) => d.name))
  for (const [name, who] of usedBy)
    if (!listed.has(name)) out.push(finding('domain-unlisted', name, { severity: 'warning', level: 'unlisted', title: `${name} is used but not in the domain list`, detail: `used by ${[...who].join(', ')}` }))
  for (const d of t.domains.list) {
    const who = usedBy.get(d.name)
    const serves = who ? `serves ${[...who].join(', ')}` : 'serves nothing in this map'
    if (who && !d.expires) out.push(finding('domain-untracked', d.name, { severity: 'warning', level: 'untracked', title: `${d.name}: expiry not tracked`, detail: `${serves}; add registrar and expires` }))
    if (who && d.auto_renew === false) out.push(finding('domain-no-autorenew', d.name, { severity: 'warning', level: 'off', title: `${d.name}: auto-renew is off`, detail: serves }))
    if (!d.expires) continue
    const days = daysUntil(d.expires, today)
    if (days > 30) continue
    if (days < 0 && !who) continue // lapsed on purpose, most likely; validate still mentions it
    const level = days < 0 ? 'expired' : days <= 1 ? '1' : days <= 7 ? '7' : days <= 14 ? '14' : '30'
    const when = days < 0 ? `expired ${-days} days ago (${d.expires})` : days === 0 ? `expires today (${d.expires})` : `expires in ${days} days (${d.expires})`
    out.push(finding('domain-expiry', d.name, { severity: who && days <= 7 ? 'critical' : 'warning', level, title: `${d.name} ${when}`, detail: `${serves}${d.registrar ? ` · registrar ${d.registrar}` : ''}${d.auto_renew ? ' · auto-renew on' : ''}` }))
  }
  return out
}

function nodes(t: Topology, live: Record<string, LiveNode> = {}) {
  const out: CheckFinding[] = []
  for (const n of t.nodes) {
    if (n.status === 'retired') continue
    const now = live[n.id]
    const status = now?.status ?? n.status
    if (status === 'degraded')
      out.push(finding('node-degraded', n.id, { severity: now?.status ? 'critical' : 'warning', level: 'degraded', title: `${n.name} is degraded`, detail: now?.status ? 'reported live (NotReady)' : 'status: degraded in the file' }))
    const pods = now?.pods ?? n.usage?.pods
    const max = n.hardware?.max_pods
    if (pods === undefined || !max) continue
    const ratio = pods / max
    if (ratio < PRESSURE.warning) continue
    const critical = ratio >= PRESSURE.critical
    out.push(
      finding('pod-pressure', n.id, {
        severity: critical ? 'critical' : 'warning',
        level: critical ? '95' : '80',
        title: `${n.name} runs ${pods} of ${max} pods (${Math.round(ratio * 100)}%)`,
        detail: `${now?.pods !== undefined ? 'live' : `sampled ${n.usage?.sampled ?? 'on an unknown date'}`}; new pods stop scheduling at ${max}`,
      }),
    )
  }
  return out
}

function databases(t: Topology) {
  const out: CheckFinding[] = []
  for (const a of t.apps ?? [])
    for (const db of a.databases ?? []) {
      const on = [...new Set(db.nodes)]
      if (on.length === 1)
        out.push(finding('single-node-database', `${a.id}/${db.name}`, { severity: 'warning', level: 'one', title: `${db.name} (${a.name}) runs on one node, ${on[0]}`, detail: `${db.engine}; offline whenever ${on[0]} is` }))
    }
  return out
}

function vulnerabilities(scan: SecurityScan | null | undefined, today: Date, severities: Severity[]) {
  const out: CheckFinding[] = []
  if (!scan) return out
  const age = -daysUntil(scan.scanned.slice(0, 10), today)
  if (age > SCAN_STALE_DAYS) out.push(finding('scan-stale', 'scan', { severity: 'warning', level: String(Math.floor(age / SCAN_STALE_DAYS) * SCAN_STALE_DAYS), title: `The dependency scan is ${age} days old`, detail: 'run malha scan to refresh it' }))
  // One finding per advisory, across every repo that ships it.
  const groups = new Map<string, { pkg: string; severity: Severity; summary: string; repos: Set<string>; apps: Set<string>; fixed: Set<string>; version: Set<string> }>()
  for (const repo of scan.repos)
    for (const f of repo.findings) {
      if (f.dev || !severities.includes(f.severity)) continue
      const id = f.ids[0]
      const g = groups.get(id) ?? { pkg: f.package, severity: f.severity, summary: f.summary, repos: new Set(), apps: new Set(), fixed: new Set(), version: new Set() }
      g.repos.add(repo.repo)
      for (const app of repo.apps) g.apps.add(app)
      if (f.fixed) g.fixed.add(f.fixed)
      g.version.add(f.version)
      groups.set(id, g)
    }
  for (const [id, g] of groups) {
    const repos = g.repos.size === 1 ? [...g.repos][0] : `${g.repos.size} repos`
    const summary = g.summary.length > 100 ? `${g.summary.slice(0, 99).trimEnd()}…` : g.summary
    out.push(
      finding('vulnerability', id, {
        severity: g.severity === 'critical' ? 'critical' : 'warning',
        level: g.severity,
        count: g.repos.size,
        title: `${g.pkg} ${[...g.version].sort().join(', ')}: ${summary}`,
        detail: `${g.severity} · ${id} · in ${repos}${g.apps.size ? ` (${[...g.apps].sort().join(', ')})` : ''}${g.fixed.size ? ` · fixed in ${[...g.fixed].sort().join(', ')}` : ' · no fix yet'}`,
      }),
    )
  }
  return out
}

function traffic(cache: AnalyticsCache | null | undefined, t: Topology, today: Date) {
  const out: CheckFinding[] = []
  if (!cache) return out
  const name = new Map((t.apps ?? []).map((a) => [a.id, a.name]))
  const age = -daysUntil(cache.fetched.slice(0, 10), today)
  if (age > ANALYTICS_STALE_DAYS) out.push(finding('analytics-stale', 'analytics', { severity: 'warning', level: String(age > 14 ? 14 : ANALYTICS_STALE_DAYS), title: `Traffic was last fetched ${age} days ago`, detail: 'run malha analytics refresh, or schedule it' }))
  for (const r of cache.results) if (!r.ok) out.push(finding('analytics-error', `${r.app}/${r.provider}`, { severity: 'warning', level: 'error', title: `${name.get(r.app) ?? r.app}: ${r.provider} ${r.id} could not be read`, detail: r.error }))
  const drop = (now: number | undefined, before: number | undefined) => (now !== undefined && before !== undefined && before >= TRAFFIC_BASELINE ? 1 - now / before : undefined)
  for (const app of new Set(cache.results.map((r) => r.app))) {
    const mine = cache.results.filter((r) => r.app === app)
    const main = primaryResult(mine)
    const label = name.get(app) ?? app
    if (main) {
      const series = main.series ?? []
      const lastTwo = series.slice(-2)
      const silent = lastTwo.length === 2 && lastTwo.every((p) => (p.visitors ?? p.pageviews ?? 0) === 0) && (main.previous?.visitors ?? 0) >= TRAFFIC_BASELINE
      const d = drop(main.totals?.visitors, main.previous?.visitors)
      if (silent)
        out.push(finding('traffic-drop', app, { severity: 'critical', level: 'silent', title: `${label} has had no visitors since ${lastTwo[0].date}`, detail: `${main.provider}: the tracker may be gone, or the site down` }))
      else if (d !== undefined && d >= TRAFFIC_DROP.warning)
        out.push(finding('traffic-drop', app, { severity: d >= TRAFFIC_DROP.critical ? 'critical' : 'warning', level: d >= TRAFFIC_DROP.critical ? '80' : '50', title: `${label}: visitors down ${Math.round(d * 100)}%`, detail: `${main.totals?.visitors} in ${cache.days} days, against ${main.previous?.visitors} before (${main.provider})` }))
    }
    const sc = mine.find((r) => r.provider === 'search-console' && r.ok && r.search)
    const sd = sc ? drop(sc.search!.totals.clicks, sc.search!.previous?.clicks) : undefined
    if (sd !== undefined && sd >= TRAFFIC_DROP.warning)
      out.push(finding('traffic-drop', `${app}/search`, { severity: 'warning', level: sd >= TRAFFIC_DROP.critical ? '80' : '50', title: `${label}: search clicks down ${Math.round(sd * 100)}%`, detail: `${sc!.search!.totals.clicks} in ${cache.days} days, against ${sc!.search!.previous?.clicks} before (Search Console)` }))
  }
  return out
}

const ORDER = { critical: 0, warning: 1 }

/** Every finding, most urgent first. */
export function runChecks(t: Topology, opts: CheckOptions = {}): CheckFinding[] {
  const today = opts.today ?? new Date()
  return [...domains(t, today), ...nodes(t, opts.live), ...databases(t), ...vulnerabilities(opts.scan, today, opts.severities ?? ['critical']), ...traffic(opts.analytics, t, today)].sort(
    (a, b) =>
      ORDER[a.severity] - ORDER[b.severity] || CHECKS.indexOf(a.check) - CHECKS.indexOf(b.check) || (b.count ?? 0) - (a.count ?? 0) || a.subject.localeCompare(b.subject),
  )
}

/** Split findings into open and accepted, by the `accepted` list in topology.yaml. */
export function applyAccepted(findings: CheckFinding[], accepted: Accepted[] = [], today = new Date()) {
  const open: CheckFinding[] = []
  const acceptedFindings: (CheckFinding & { why: string })[] = []
  for (const f of findings) {
    const match = accepted.find((a) => a.check === f.check && (a.subject === undefined || a.subject === f.subject) && (!a.until || daysUntil(a.until, today) >= 0))
    if (match) acceptedFindings.push({ ...f, why: match.why })
    else open.push(f)
  }
  return { open, accepted: acceptedFindings }
}
