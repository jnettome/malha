import { copyFileSync, cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { notify } from '../src/cli/check.ts'
import { checkTopology, loadTopology } from '../src/cli/load.ts'
import { applyAccepted, runChecks, type CheckFinding } from '../src/core/check.ts'
import type { SecurityScan } from '../src/core/security.ts'
import type { Topology } from '../src/core/types.ts'
import { addPlugin } from '../src/plugins/commands.ts'
import { applyChanges, checkChanges } from '../src/plugins/edit.ts'
import { runPlugin, type Answer, type Question } from '../src/plugins/host.ts'
import { expandPatterns } from '../src/plugins/rules.ts'
import { inspect, readProject, writeProject, type Resolved } from '../src/plugins/project.ts'
import type { CheckReport, CommandResult, NotifyResult } from '../src/plugins/sdk.ts'

const EXAMPLE = 'examples/acme/topology.yaml'
const acme = () => structuredClone(loadTopology(EXAMPLE).data!) as Topology
const day = (iso: string) => new Date(`${iso}T12:00:00`)
const ids = (findings: CheckFinding[]) => findings.map((f) => `${f.id}@${f.level}/${f.severity}`)

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'malha-check-'))
  const file = join(dir, 'topology.yaml')
  copyFileSync(EXAMPLE, file)
  return { dir, file }
}

const resolved = (dir: string, options: Record<string, unknown> = {}): Resolved => {
  const { manifest, integrity, files } = inspect(dir)
  const { patterns, problems } = expandPatterns(manifest.permissions.fetch, options)
  return { name: manifest.name, dir, builtin: false, manifest: { ...manifest, permissions: { ...manifest.permissions, fetch: patterns } }, integrity, files, entry: { source: dir, options }, warnings: problems }
}

function asker(answer: Answer = 'once') {
  const asked: Question[] = []
  return { asked, ask: async (q: Question) => (asked.push(q), answer) }
}

describe('malha check', () => {
  it('raises a domain as its expiry nears, more urgently when it serves something', () => {
    const t = acme()
    expect(runChecks(t, { today: day('2026-10-01') }).filter((f) => f.check === 'domain-expiry')).toEqual([])
    expect(ids(runChecks(t, { today: day('2026-10-25') }).filter((f) => f.check === 'domain-expiry'))).toEqual(['domain-expiry:acme-old.example@30/warning'])
    expect(ids(runChecks(t, { today: day('2026-11-15') }).filter((f) => f.check === 'domain-expiry'))).toEqual(['domain-expiry:acme-old.example@7/warning'])
    expect(ids(runChecks(t, { today: day('2027-06-25') }).filter((f) => f.check === 'domain-expiry'))).toEqual(['domain-expiry:acme-status.example@expired/critical', 'domain-expiry:acme.example@7/critical'])
    // A domain that serves nothing and has lapsed is left to validate.
    expect(runChecks(t, { today: day('2026-12-01') }).filter((f) => f.subject === 'acme-old.example' && f.check === 'domain-expiry')).toEqual([])
  })

  it('uses live numbers for nodes when it has them', () => {
    const t = acme()
    expect(ids(runChecks(t, { today: day('2026-10-01') }).filter((f) => f.check === 'pod-pressure'))).toEqual(['pod-pressure:w1@80/warning'])
    const live = runChecks(t, { today: day('2026-10-01'), live: { w1: { pods: 108 }, w2: { status: 'degraded' } } })
    expect(ids(live.filter((f) => f.check === 'pod-pressure' || f.check === 'node-degraded'))).toEqual(['node-degraded:w2@degraded/critical', 'pod-pressure:w1@95/critical'])
  })

  it('names databases that live on a single node', () => {
    const t = acme()
    t.apps![0].databases = [{ name: 'shop-db', engine: 'postgres', nodes: ['w1', 'w1'] }]
    expect(runChecks(t).filter((f) => f.check === 'single-node-database').map((f) => f.subject)).toContain('shop/shop-db')
  })

  it('groups a vulnerability across repos, skips dev-only ones, and flags an old scan', () => {
    const finding = (pkg: string, id: string, severity: 'critical' | 'high', dev = false) => ({ lockfile: 'package-lock.json', ecosystem: 'npm', package: pkg, version: '1.0.0', severity, ids: [id], summary: `${pkg} is bad`, fixed: '1.0.1', dev })
    const repo = (name: string, apps: string[], findings: ReturnType<typeof finding>[]) => ({ repo: name, apps, status: 'scanned' as const, lockfiles: [], skipped: [], counts: {} as never, devCounts: {} as never, packages: 1, findings })
    const scan: SecurityScan = {
      scanned: '2026-10-01T00:00:00Z',
      tool: 'test',
      mode: 'online',
      repos: [repo('github.com/acme/a', ['shop'], [finding('left', 'GHSA-1', 'critical'), finding('dev-only', 'GHSA-2', 'critical', true)]), repo('github.com/acme/b', ['api'], [finding('left', 'GHSA-1', 'critical'), finding('right', 'GHSA-3', 'high')])],
    }
    const found = runChecks(acme(), { today: day('2026-10-05'), scan })
    expect(found.filter((f) => f.check === 'vulnerability').map((f) => [f.subject, f.count, f.detail])).toEqual([['GHSA-1', 2, 'critical · GHSA-1 · in 2 repos (api, shop) · fixed in 1.0.1']])
    expect(runChecks(acme(), { today: day('2026-10-05'), scan, severities: ['critical', 'high'] }).filter((f) => f.check === 'vulnerability')).toHaveLength(2)
    expect(ids(runChecks(acme(), { today: day('2026-11-01'), scan }).filter((f) => f.check === 'scan-stale'))).toEqual(['scan-stale:scan@28/warning'])
  })

  it('honours accepted findings until their date', () => {
    const found = runChecks(acme(), { today: day('2026-10-25') })
    const accepted = [{ check: 'domain-expiry' as const, subject: 'acme-old.example', why: 'letting it go', until: '2026-10-31' }, { check: 'pod-pressure' as const, why: 'busy on purpose' }]
    const now = applyAccepted(found, accepted, day('2026-10-25'))
    expect(now.accepted.map((f) => `${f.id}: ${f.why}`)).toEqual(['domain-expiry:acme-old.example: letting it go', 'pod-pressure:w1: busy on purpose'])
    expect(applyAccepted(found, accepted, day('2026-11-01')).accepted.map((f) => f.id)).toEqual(['pod-pressure:w1'])
    // The schema takes the list.
    const text = `${readFileSync(EXAMPLE, 'utf8')}\naccepted:\n  - { check: pod-pressure, subject: w1, why: busy on purpose, until: 2027-01-01 }\n`
    expect(checkTopology(text).errors).toEqual([])
    expect(checkTopology(text.replace('check: pod-pressure', 'check: nope')).errors.length).toBeGreaterThan(0)
  })
})

describe('malha check --notify', () => {
  const finding = (id: string, level: string): CheckFinding => ({ id: `domain-expiry:${id}`, check: 'domain-expiry', subject: id, severity: 'warning', level, title: `${id} at ${level}` })
  const sent = (r: Awaited<ReturnType<typeof notify>>) => JSON.parse(r[0].result!.message!) as { findings: string[]; resolved: string[]; digest: boolean }

  it('announces what is new or worse, then what was resolved, and only once', async () => {
    const { file } = scratch()
    await addPlugin(file, 'tests/fixtures/plugins/notifier', { yes: true })
    expect(sent(await notify(file, 'Acme', [finding('a', '30'), finding('b', '30')], new Set(), false)).findings).toEqual(['domain-expiry:a', 'domain-expiry:b'])
    expect(await notify(file, 'Acme', [finding('a', '30'), finding('b', '30')], new Set(), false)).toEqual([])
    expect(sent(await notify(file, 'Acme', [finding('a', '14')], new Set(), false))).toMatchObject({ findings: ['domain-expiry:a'], resolved: ['domain-expiry:b'] })
    expect(sent(await notify(file, 'Acme', [finding('a', '14')], new Set(), true))).toMatchObject({ findings: ['domain-expiry:a'], digest: true })
  })

  it('keeps unsent findings for the next run when no notifier takes them', async () => {
    const { file } = scratch()
    await addPlugin(file, 'tests/fixtures/plugins/notifier', { yes: true })
    const project = readProject(file)
    project.plugins.notifier.options = { fail: true }
    writeProject(file, project)
    const exitCode = process.exitCode
    expect((await notify(file, 'Acme', [finding('a', '30')], new Set(), false))[0].result).toEqual({ sent: false, message: 'told to fail' })
    process.exitCode = exitCode
    project.plugins.notifier.options = {}
    writeProject(file, project)
    expect(sent(await notify(file, 'Acme', [finding('a', '30')], new Set(), false)).findings).toEqual(['domain-expiry:a'])
  })
})

describe('notifier plugins', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.DISCORD_WEBHOOK_URL
    delete process.env.SLACK_WEBHOOK_URL
  })
  const report = (n: number): CheckReport => ({
    project: 'Acme',
    command: 'malha check topology.yaml',
    open: n,
    digest: false,
    resolved: [{ id: 'pod-pressure:w1', title: 'worker-1 runs 90 of 110 pods' }],
    findings: Array.from({ length: n }, (_, i) => ({ id: `vulnerability:GHSA-${i}`, check: 'vulnerability' as const, subject: `GHSA-${i}`, severity: 'critical' as const, level: 'critical', title: `pkg-${i} @everyone is broken ${'x'.repeat(80)}` })),
  })
  const capture = () => {
    const bodies: { url: string; body: Record<string, unknown> }[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      bodies.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> })
      return new Response(null, { status: 204 })
    })
    return bodies
  }

  it('posts to a Discord webhook, capped, split, and without mentions', async () => {
    const { file } = scratch()
    process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/1/abc'
    const bodies = capture()
    const r = (await runPlugin({ file, plugin: resolved(resolve('plugins/discord')), run: { kind: 'notify' }, input: report(40), asker: asker() })) as NotifyResult
    expect(r.sent).toBe(true)
    expect(bodies.every((b) => b.url === process.env.DISCORD_WEBHOOK_URL && String(b.body.content).length <= 2000)).toBe(true)
    const all = bodies.map((b) => String(b.body.content)).join('\n')
    expect(all).toContain('**Acme** · malha check · 40 new or worse (40 critical) · 40 open')
    expect(all).toContain('… and 30 more advisories')
    expect(all).toContain('✅ worker-1 runs 90 of 110 pods')
    expect(bodies[0].body.allowed_mentions).toEqual({ parse: [] })
  })

  it('refuses a webhook on another host, and says so when there is none', async () => {
    const { file } = scratch()
    const a = asker()
    const none = (await runPlugin({ file, plugin: resolved(resolve('plugins/discord')), run: { kind: 'notify' }, input: report(1), asker: a })) as NotifyResult
    expect(none).toMatchObject({ sent: false })
    expect(a.asked).toEqual([]) // nothing set, nothing to ask about
    process.env.DISCORD_WEBHOOK_URL = 'https://evil.test/api/webhooks/1/abc'
    capture()
    await expect(runPlugin({ file, plugin: resolved(resolve('plugins/discord')), run: { kind: 'notify' }, input: report(1), asker: asker() })).rejects.toThrow(/not declared/)
  })

  it('posts to a Slack webhook', async () => {
    const { file } = scratch()
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/T/B/x'
    const bodies = capture()
    const r = (await runPlugin({ file, plugin: resolved(resolve('plugins/slack')), run: { kind: 'notify' }, input: report(2), asker: asker() })) as NotifyResult
    expect(r.sent).toBe(true)
    expect(String(bodies[0].body.text)).toContain(':red_circle: pkg-0 @everyone is broken')
  })
})

describe('the porkbun and cloudflare plugins', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.PORKBUN_API_KEY
    delete process.env.PORKBUN_SECRET_API_KEY
    delete process.env.CLOUDFLARE_API_TOKEN
  })
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

  async function run(name: string, command: string, file: string) {
    const r = (await runPlugin({ file, plugin: resolved(resolve(`plugins/${name}`)), run: { kind: 'command', name: command }, asker: asker() })) as CommandResult
    const { ok, problems } = checkChanges(r.changes)
    expect(problems).toEqual([])
    const p = applyChanges(readFileSync(file, 'utf8'), ok, '2026-10-25')
    expect(p.problems).toEqual([])
    expect(checkTopology(p.text).errors).toEqual([])
    return { message: r.message ?? '', text: p.text, data: parse(p.text) as Topology }
  }

  it('porkbun sync: registrar, expiry and auto-renew, never removing anything', async () => {
    const { file } = scratch()
    process.env.PORKBUN_API_KEY = 'pk'
    process.env.PORKBUN_SECRET_API_KEY = 'sk'
    const calls: string[] = []
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { start: string; apikey: string }
      calls.push(`${body.apikey}:${body.start}`)
      return json(body.start === '0' ? { status: 'SUCCESS', domains: [{ domain: 'acme.example', expireDate: '2028-06-30 00:00:00', autoRenew: '1' }, { domain: 'acme-new.example', expireDate: '2027-01-02 00:00:00', autoRenew: 0 }] } : { status: 'SUCCESS', domains: [] })
    })
    const { message, data } = await run('porkbun', 'sync', file)
    expect(calls).toEqual(['pk:0', 'pk:1000'])
    const list = data.domains!.list
    expect(list.find((d) => d.name === 'acme.example')).toMatchObject({ expires: '2028-06-30', auto_renew: true })
    expect(list[0]).toEqual({ name: 'acme-new.example', registrar: 'porkbun', expires: '2027-01-02', auto_renew: false })
    expect(list.map((d) => d.name)).toContain('acme-old.example')
    expect(data.domains!.checked).toBe(new Date().toLocaleDateString('sv'))
    expect(message).toContain('not in the Porkbun account (transferred or lapsed?): acme-old.example, acme-status.example')
  })

  it('cloudflare records: hostnames for apps, links for machines, and dangling records', async () => {
    const { file } = scratch()
    process.env.CLOUDFLARE_API_TOKEN = 'cf'
    const records = [
      { type: 'A', name: 'acme.example', content: '203.0.113.10', proxied: true },
      { type: 'CNAME', name: 'beta.shop.acme.example', content: 'lb-1.acme.example', proxied: true },
      { type: 'A', name: 'backups.acme.example', content: '198.51.100.40', proxied: false },
      { type: 'A', name: 'old.acme.example', content: '192.0.2.99', proxied: false },
      { type: 'TXT', name: 'acme.example', content: 'v=spf1', proxied: false },
      { type: 'CNAME', name: '_acme-challenge.acme.example', content: 'x.example', proxied: false },
    ]
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer cf')
      const u = new URL(url)
      if (u.pathname === '/client/v4/zones') return json({ success: true, result: [{ id: 'z1', name: 'acme.example', status: 'active', plan: { legacy_id: 'pro' } }], result_info: { total_pages: 1 } })
      return json({ success: true, result: records, result_info: { total_pages: 1 } })
    })
    const { message, data } = await run('cloudflare', 'records', file)
    expect(data.apps!.find((a) => a.id === 'shop')!.domains).toContain('beta.shop.acme.example')
    expect(data.links!.at(-1)).toEqual({ from: 'internet', to: 'backup', kind: 'http', ports: [80, 443], label: 'backups.acme.example (from DNS)' })
    expect(message).toContain('Point at addresses no machine in the file has: old.acme.example → 192.0.2.99')
    expect(message).toContain('Listed by an app, with no DNS record:')
  })

  it('cloudflare zones: DNS host and plan per zone', async () => {
    const { file } = scratch()
    process.env.CLOUDFLARE_API_TOKEN = 'cf'
    vi.stubGlobal('fetch', async () => json({ success: true, result: [{ id: 'z1', name: 'acme.example', status: 'active', plan: { legacy_id: 'business' } }, { id: 'z2', name: 'acme-blog.example', status: 'pending', plan: { name: 'Free Website' } }], result_info: { total_pages: 1 } }))
    const { message, data } = await run('cloudflare', 'zones', file)
    expect(data.domains!.list.find((d) => d.name === 'acme.example')!.plan).toBe('business')
    expect(data.domains!.list.find((d) => d.name === 'acme-blog.example')).toEqual({ name: 'acme-blog.example', dns: 'cloudflare', plan: 'free' })
    expect(message).toContain('Not active: acme-blog.example (pending)')
  })
})

describe('editing from the top of the file', () => {
  const text = readFileSync(EXAMPLE, 'utf8')
  it('sets domains.checked and meta, and nothing else at the top', () => {
    const { ok, problems } = checkChanges([{ set: { 'domains.checked': '2026-10-25', 'meta.pods_sampled': '2026-10-25' } }, { set: { 'nodes.0.id': 'x' } }, { set: { 'domains.list': [] } }])
    expect(problems).toHaveLength(2)
    const r = applyChanges(text, ok, '2026-10-25')
    expect(r.text).toContain('domains:\n  checked: 2026-10-25\n')
    expect(r.text).toContain('  pods_sampled: 2026-10-25\n')
  })
})

it('copies plugin folders without symlinks for tests', () => {
  // Guards the fixtures: hashPlugin refuses symlinks, so a broken fixture would fail every run above.
  const dir = mkdtempSync(join(tmpdir(), 'malha-fixture-'))
  cpSync('tests/fixtures/plugins/notifier', dir, { recursive: true })
  expect(inspect(dir).manifest.name).toBe('notifier')
  writeFileSync(join(dir, 'x'), '')
})
