import { useEffect, useState } from 'react'
import { loadScan } from '../source.ts'
import type { Finding, RepoScan, SecurityScan, Severity } from '../../core/security.ts'
import { SEVERITIES } from '../../core/security.ts'

// The scan can be a megabyte or more, so it is fetched the first time something needs it.
let cached: SecurityScan | null | undefined
let pending: Promise<SecurityScan | null> | undefined
const loadScanOnce = () => (pending ??= loadScan().then((s) => (cached = s)))

/** infra/security/scan.json: undefined while loading, null before the first `npm run security:scan`. */
export function useScan() {
  const [scan, setScan] = useState(cached)
  useEffect(() => {
    if (cached === undefined) loadScanOnce().then(setScan)
  }, [])
  return scan
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  unknown: 'Unknown',
}

export const emptyCounts = (): Record<Severity, number> => Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>

export const reposOf = (scan: SecurityScan, appId: string): RepoScan[] => scan.repos.filter((r) => r.apps.includes(appId))

/** Severity counts over some repos; dev-only pairs added when asked. */
export function sumCounts(repos: RepoScan[], includeDev: boolean) {
  const total = emptyCounts()
  for (const r of repos) for (const s of SEVERITIES) total[s] += r.counts[s] + (includeDev ? r.devCounts[s] : 0)
  return total
}

export const countTotal = (c: Record<Severity, number>) => SEVERITIES.reduce((n, s) => n + c[s], 0)

export const visibleFindings = (r: RepoScan, includeDev: boolean): Finding[] => r.findings.filter((f) => includeDev || !f.dev)

export interface HotPackage {
  ecosystem: string
  package: string
  repos: string[]
  /** Distinct fix versions across repos, lowest first (each repo may sit on a different major). */
  fixes: string[]
  summary: string
}

/** Packages with an advisory of this severity, by how many repos carry them. */
export function hotPackages(scan: SecurityScan, severity: Severity, includeDev: boolean): HotPackage[] {
  const map = new Map<string, HotPackage>()
  for (const r of scan.repos) {
    for (const f of visibleFindings(r, includeDev)) {
      if (f.severity !== severity) continue
      const key = `${f.ecosystem}|${f.package}`
      const hot = map.get(key) ?? { ecosystem: f.ecosystem, package: f.package, repos: [], fixes: [], summary: f.summary }
      if (!hot.repos.includes(r.repo)) hot.repos.push(r.repo)
      if (f.fixed && !hot.fixes.includes(f.fixed)) hot.fixes.push(f.fixed)
      map.set(key, hot)
    }
  }
  for (const hot of map.values()) hot.fixes.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  return [...map.values()].sort((a, b) => b.repos.length - a.repos.length || a.package.localeCompare(b.package))
}

export const shortRepo = (repo: string) => repo.replace(/^gitlab\.com\//, '').replace(/^github\.com\//, 'gh:')

export const advisoryUrl = (id: string) => `https://osv.dev/vulnerability/${encodeURIComponent(id)}`
