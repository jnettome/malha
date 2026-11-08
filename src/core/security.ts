// Shape of .malha/scan.json, written by `malha scan` and read by the Security tab.

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'unknown'
export const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'unknown']

export interface Finding {
  /** Lockfile path inside the repo. */
  lockfile: string
  ecosystem: string
  package: string
  version: string
  severity: Severity
  /** Highest CVSS base score in the advisory group, when published. */
  score?: number
  /** Advisory id first, then aliases (GHSA, CVE, …). */
  ids: string[]
  summary: string
  /** Lowest version that fixes it, from the range the installed version falls in. */
  fixed?: string
  /** Only a development dependency (npm lockfiles mark these; Bundler's don't). */
  dev?: boolean
}

export interface RepoScan {
  /** Git remote, e.g. github.com/acme/storefront. */
  repo: string
  /** App ids whose images come from this repo. */
  apps: string[]
  status: 'scanned' | 'not-cloned' | 'no-lockfiles' | 'error'
  message?: string
  /** Clone path relative to the code folder. */
  local?: string
  /** The ref that was scanned, e.g. origin/main, and its commit. */
  ref?: string
  commit?: string
  committed?: string
  fetched?: boolean
  lockfiles: string[]
  /** Lockfiles found but not readable by the scanner (bun.lockb). */
  skipped: string[]
  /** Distinct package + advisory pairs that ship (not dev-only), by severity. */
  counts: Record<Severity, number>
  /** The same for dev-only dependencies. */
  devCounts: Record<Severity, number>
  /** Distinct vulnerable packages that ship. */
  packages: number
  findings: Finding[]
}

export interface SecurityScan {
  scanned: string
  tool: string
  mode: 'online' | 'offline'
  /** Where the clones were looked for, with ~ for the home folder. */
  codeDir?: string
  repos: RepoScan[]
}
