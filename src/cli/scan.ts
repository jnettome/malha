/**
 * `malha scan`: known vulnerabilities in the dependencies behind every app.
 *
 * For each repo in `apps[].repos` it finds the local clone under the code folder by its git
 * remote, fetches, and reads the lockfiles from the remote's default branch with `git show`, so
 * local edits and unpushed work don't count. All lockfiles go through one OSV-Scanner run. The
 * result is written to .malha/scan.json next to the topology file, where `malha dev` and
 * `malha build` pick it up.
 *
 * Online mode sends package names and versions (not code) to api.osv.dev; --offline downloads the
 * vulnerability databases instead. Needs OSV-Scanner 2 on PATH, in ~/go/bin, or in $OSV_SCANNER.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { promisify } from 'node:util'
import type { Finding, RepoScan, SecurityScan, Severity } from '../core/security.ts'
import { SEVERITIES } from '../core/security.ts'
import { loadTopology } from './load.ts'
import { display, scanPath, tildify } from './paths.ts'

const run = promisify(execFile)

const LOCKFILES = new Set([
  'Gemfile.lock',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'go.mod',
  'requirements.txt',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'composer.lock',
  'Cargo.lock',
  'mix.lock',
  'pubspec.lock',
])
const UNREADABLE = new Set(['bun.lockb'])
// Example apps, docs and tests have lockfiles that never reach an image.
const SKIP_DIRS = /(^|\/)(node_modules|vendor|fixtures|examples?|docs?|tests?|spec|__tests__|e2e|\.git)\//
const FETCH_TIMEOUT = 60_000
const PARALLEL = 6

export interface ScanOptions {
  /** Folder holding the git clones, searched four levels deep. */
  codeDir: string
  apps: string[]
  fetch: boolean
  offline: boolean
}

const git = async (dir: string, ...args: string[]) =>
  (
    await run('git', ['-C', dir, ...args], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: FETCH_TIMEOUT,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=10' },
    })
  ).stdout

/** git@gitlab.com:group/repo.git, https://gitlab.com/group/repo → gitlab.com/group/repo */
export function normalizeRemote(url: string) {
  return url
    .trim()
    .replace(/^[a-z+]+:\/\//, '')
    .replace(/^[^@/]+@/, '')
    .replace(/^([^/:]+):(?!\d)/, '$1/')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/** Every git clone under the code folder, by normalized origin remote. */
async function findClones(codeDir: string, depth = 4) {
  const dirs: string[] = []
  const walk = (dir: string, level: number) => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    if (entries.includes('.git')) dirs.push(dir)
    if (level >= depth) return
    for (const e of entries) {
      if (e === '.git' || e === 'node_modules' || e === 'vendor' || e.startsWith('.')) continue
      const p = join(dir, e)
      try {
        if (statSync(p).isDirectory()) walk(p, level + 1)
      } catch {
        // unreadable entry
      }
    }
  }
  walk(codeDir, 0)
  const byRemote = new Map<string, string[]>()
  await pool(dirs, async (dir) => {
    try {
      const remote = normalizeRemote(await git(dir, 'remote', 'get-url', 'origin'))
      byRemote.set(remote, [...(byRemote.get(remote) ?? []), dir])
    } catch {
      // no origin
    }
  })
  return byRemote
}

async function pool<T>(items: T[], fn: (item: T) => Promise<void>) {
  const queue = [...items]
  await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift()!)
  }))
}

function findOsv() {
  for (const candidate of [process.env.OSV_SCANNER, 'osv-scanner', join(homedir(), 'go', 'bin', 'osv-scanner')]) {
    if (!candidate) continue
    if (candidate.includes('/') ? existsSync(candidate) : process.env.PATH?.split(':').some((d) => existsSync(join(d, candidate)))) return candidate
  }
  throw new Error('OSV-Scanner not found. Install it (go install github.com/google/osv-scanner/v2/cmd/osv-scanner@v2.6.0), or set $OSV_SCANNER')
}

// ── Versions and severity ─────────────────────────────────────────────────────

/** Loose version compare: numeric parts numerically, the rest as text; 1.2.0 < 1.10. */
export function compareVersions(a: string, b: string) {
  const pa = a.split(/[.\-+_]/)
  const pb = b.split(/[.\-+_]/)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0'
    const y = pb[i] ?? '0'
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) {
      if (Number(x) !== Number(y)) return Number(x) - Number(y)
    } else if (x !== y) {
      // A pre-release tag (beta1) sorts before the plain release it precedes.
      if (nx) return 1
      if (ny) return -1
      return x < y ? -1 : 1
    }
  }
  return 0
}

interface OsvEvent {
  introduced?: string
  fixed?: string
  last_affected?: string
}
interface OsvVuln {
  id: string
  aliases?: string[]
  summary?: string
  details?: string
  database_specific?: { severity?: string }
  affected?: { package?: { name?: string }; ranges?: { type: string; events: OsvEvent[] }[] }[]
}
export interface OsvPackage {
  package: { name: string; version: string; ecosystem: string }
  dependency_groups?: string[]
  vulnerabilities?: OsvVuln[]
  groups?: { ids: string[]; aliases?: string[]; max_severity?: string }[]
}

/** Lowest `fixed` from a range that covers the installed version. */
function fixedFor(vulns: OsvVuln[], name: string, version: string) {
  const fixes: string[] = []
  for (const v of vulns) {
    for (const aff of v.affected ?? []) {
      if (aff.package?.name && aff.package.name.toLowerCase() !== name.toLowerCase()) continue
      for (const range of aff.ranges ?? []) {
        if (range.type !== 'ECOSYSTEM' && range.type !== 'SEMVER') continue
        let introduced: string | undefined
        for (const e of range.events) {
          if (e.introduced !== undefined) introduced = e.introduced
          if (e.fixed !== undefined && introduced !== undefined) {
            const covers = (introduced === '0' || compareVersions(version, introduced) >= 0) && compareVersions(version, e.fixed) < 0
            if (covers) fixes.push(e.fixed)
            introduced = undefined
          }
        }
      }
    }
  }
  return fixes.sort(compareVersions)[0]
}

function severityOf(score: number | undefined, label: string | undefined): Severity {
  if (score !== undefined && score > 0) return score >= 9 ? 'critical' : score >= 7 ? 'high' : score >= 4 ? 'medium' : 'low'
  switch (label?.toUpperCase()) {
    case 'CRITICAL':
      return 'critical'
    case 'HIGH':
      return 'high'
    case 'MODERATE':
    case 'MEDIUM':
      return 'medium'
    case 'LOW':
      return 'low'
    default:
      return 'unknown'
  }
}

export function findingsFrom(pkg: OsvPackage, lockfile: string): Finding[] {
  const vulns = pkg.vulnerabilities ?? []
  const byId = new Map(vulns.map((v) => [v.id, v]))
  type Group = NonNullable<OsvPackage['groups']>[number]
  const groups: Group[] = pkg.groups?.length ? pkg.groups : vulns.map((v) => ({ ids: [v.id], aliases: v.aliases }))
  return groups.map((g) => {
    const members = g.ids.map((id) => byId.get(id)).filter((v): v is OsvVuln => v !== undefined)
    const first = members[0]
    const score = g.max_severity ? Number(g.max_severity) : undefined
    const label = members.map((v) => v.database_specific?.severity).find(Boolean)
    const ids = [...new Set([...g.ids, ...(g.aliases ?? [])])].sort((a, b) => (a.startsWith('GHSA') ? -1 : 0) - (b.startsWith('GHSA') ? -1 : 0))
    return {
      lockfile,
      ecosystem: pkg.package.ecosystem,
      package: pkg.package.name,
      version: pkg.package.version,
      severity: severityOf(Number.isFinite(score) ? score : undefined, label),
      score: Number.isFinite(score) && score! > 0 ? score : undefined,
      ids,
      summary: first?.summary ?? first?.details?.split('\n')[0]?.slice(0, 200) ?? '',
      fixed: fixedFor(members, pkg.package.name, pkg.package.version),
      dev: pkg.dependency_groups?.includes('dev') || undefined,
    }
  })
}

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * Count each package + advisory once per repo, however many lockfiles carry it. It counts as
 * shipping unless every copy is a dev-only dependency.
 */
function tally(r: RepoScan) {
  const pairs = new Map<string, { severity: Severity; dev: boolean; pkg: string }>()
  for (const f of r.findings) {
    const key = `${f.ecosystem}|${f.package}|${f.ids[0]}`
    const prev = pairs.get(key)
    const severity = prev && SEVERITIES.indexOf(prev.severity) < SEVERITIES.indexOf(f.severity) ? prev.severity : f.severity
    pairs.set(key, { severity, dev: (prev?.dev ?? true) && Boolean(f.dev), pkg: `${f.ecosystem}|${f.package}` })
  }
  const shipped = new Set<string>()
  for (const p of pairs.values()) {
    if (p.dev) r.devCounts[p.severity]++
    else {
      r.counts[p.severity]++
      shipped.add(p.pkg)
    }
  }
  r.packages = shipped.size
}

const emptyCounts = () => Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>
const slug = (repo: string) => repo.replace(/[^a-z0-9]+/gi, '_')

export async function scan(file: string, args: ScanOptions) {
  const { data, errors } = loadTopology(file)
  if (!data || errors.length) throw new Error(`${display(file)} is invalid; run malha validate`)
  if (!existsSync(args.codeDir)) throw new Error(`code folder ${args.codeDir} does not exist`)

  const appsByRepo = new Map<string, string[]>()
  for (const app of data.apps ?? []) {
    if (args.apps.length && !args.apps.includes(app.id)) continue
    for (const r of app.repos ?? []) appsByRepo.set(r.toLowerCase(), [...(appsByRepo.get(r.toLowerCase()) ?? []), app.id])
  }
  if (!appsByRepo.size) throw new Error(args.apps.length ? `no repos for ${args.apps.join(', ')}` : 'no app lists repos')

  const osv = findOsv()
  const osvVersion = (await run(osv, ['--version'])).stdout.match(/osv-scanner version: (\S+)/)?.[1] ?? 'unknown'
  console.log(`Finding clones under ${args.codeDir} …`)
  const clones = await findClones(args.codeDir)

  const work = mkdtempSync(join(tmpdir(), 'malha-scan-'))
  const results = new Map<string, RepoScan>()
  try {
    await pool([...appsByRepo.keys()], async (repo) => {
      const scan: RepoScan = {
        repo,
        apps: appsByRepo.get(repo)!,
        status: 'scanned',
        lockfiles: [],
        skipped: [],
        counts: emptyCounts(),
        devCounts: emptyCounts(),
        packages: 0,
        findings: [],
      }
      results.set(repo, scan)
      // Several folders can share a remote (worktrees, branch copies). They all read the same
      // origin branch; pick one deterministically: named like the repo, not archived, shortest.
      const name = repo.split('/').at(-1)!
      const rank = (d: string) => [/\/archived?\//i.test(d) ? 1 : 0, d.split('/').at(-1)!.toLowerCase() === name ? 0 : 1, d.length]
      const candidates = [...(clones.get(repo) ?? [])].sort((a, b) => {
        const [ra, rb] = [rank(a), rank(b)]
        return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2] || a.localeCompare(b)
      })
      const dir = candidates[0]
      if (!dir) {
        scan.status = 'not-cloned'
        scan.message = `no clone under ${args.codeDir} with origin ${repo}`
        return
      }
      scan.local = relative(args.codeDir, dir)
      const others = candidates.slice(1).map((d) => relative(args.codeDir, d))
      if (others.length) scan.message = `${others.length} other local cop${others.length > 1 ? 'ies' : 'y'}: ${others.slice(0, 3).join(', ')}${others.length > 3 ? ', …' : ''}`
      if (args.fetch) {
        try {
          await git(dir, 'fetch', '--quiet', 'origin')
          scan.fetched = true
        } catch (e) {
          scan.fetched = false
          console.warn(`warn  ${repo}: git fetch failed, scanning the last fetched refs (${String((e as Error).message).split('\n')[0]})`)
        }
      }
      let ref = ''
      for (const candidate of ['origin/HEAD', 'origin/main', 'origin/master']) {
        try {
          ref = (await git(dir, 'rev-parse', '--abbrev-ref', candidate)).trim()
          break
        } catch {
          // try the next one
        }
      }
      if (!ref) {
        ref = 'HEAD'
        scan.message = [scan.message, 'no remote default branch; scanned the local HEAD'].filter(Boolean).join('; ')
      }
      scan.ref = ref
      const [commit, committed] = (await git(dir, 'log', '-1', '--format=%h %cs', ref)).trim().split(' ')
      Object.assign(scan, { commit, committed })
      const files = (await git(dir, 'ls-tree', '-r', '--name-only', ref)).split('\n').filter(Boolean)
      for (const f of files) {
        if (SKIP_DIRS.test(f)) continue
        const base = f.split('/').at(-1)!
        if (UNREADABLE.has(base)) scan.skipped.push(f)
        if (!LOCKFILES.has(base)) continue
        const target = join(work, slug(repo), f)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, await git(dir, 'show', `${ref}:${f}`))
        scan.lockfiles.push(f)
      }
      if (!scan.lockfiles.length) scan.status = 'no-lockfiles'
    })

    const scanned = [...results.values()].filter((r) => r.status === 'scanned')
    if (scanned.length) {
      console.log(`Scanning ${scanned.reduce((n, r) => n + r.lockfiles.length, 0)} lockfiles from ${scanned.length} repos with OSV-Scanner ${osvVersion} (${args.offline ? 'offline' : 'api.osv.dev'}) …`)
      const flags = ['scan', 'source', '--format', 'json', '--recursive', '--no-ignore', '--allow-no-lockfiles']
      if (args.offline) flags.push('--offline-vulnerabilities', '--download-offline-databases')
      let stdout: string
      try {
        stdout = (await run(osv, [...flags, work], { maxBuffer: 512 * 1024 * 1024 })).stdout
      } catch (e) {
        // Exit code 1 means "vulnerabilities found"; anything else is a failure.
        const err = e as { code?: number; stdout?: string; stderr?: string }
        if (err.code !== 1 || !err.stdout) throw new Error(`osv-scanner failed (${err.code}): ${err.stderr?.split('\n').slice(-3).join(' ')}`)
        stdout = err.stdout
      }
      const report = JSON.parse(stdout) as { results?: { source: { path: string }; packages?: OsvPackage[] }[] }
      const bySlug = new Map(scanned.map((r) => [slug(r.repo), r]))
      for (const result of report.results ?? []) {
        const rel = relative(work, result.source.path)
        const [repoSlug, ...rest] = rel.split('/')
        const scan = bySlug.get(repoSlug)
        if (!scan) continue
        for (const pkg of result.packages ?? []) scan.findings.push(...findingsFrom(pkg, rest.join('/')))
      }
      for (const r of scanned) {
        r.findings.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || (b.score ?? 0) - (a.score ?? 0) || a.package.localeCompare(b.package))
        tally(r)
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }

  const repos = [...results.values()].sort((a, b) => a.repo.localeCompare(b.repo))
  const output: SecurityScan = {
    scanned: new Date().toISOString(),
    tool: `osv-scanner ${osvVersion}`,
    mode: args.offline ? 'offline' : 'online',
    codeDir: tildify(args.codeDir),
    repos,
  }
  const out = scanPath(file)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(output, null, 1)}\n`)

  const pad = (s: string | number, n: number) => String(s).padEnd(n)
  console.log(`\nShipping dependencies, each package + advisory counted once per repo (dev-only ones in the JSON):`)
  console.log(`${pad('repo', 52)} ${pad('crit', 5)}${pad('high', 5)}${pad('med', 5)}${pad('low', 5)}status`)
  for (const r of [...repos].sort((a, b) => b.counts.critical - a.counts.critical || b.counts.high - a.counts.high || a.repo.localeCompare(b.repo))) {
    const c = r.counts
    console.log(`${pad(r.repo.replace(/^gitlab\.com\//, ''), 52)} ${pad(c.critical, 5)}${pad(c.high, 5)}${pad(c.medium, 5)}${pad(c.low, 5)}${r.status}${r.ref ? ` ${r.ref}@${r.commit}` : ''}`)
  }
  const total = emptyCounts()
  for (const r of repos) for (const s of SEVERITIES) total[s] += r.counts[s]
  console.log(`\n${SEVERITIES.map((s) => `${total[s]} ${s}`).join(', ')}. Wrote ${display(out)}.`)
}
