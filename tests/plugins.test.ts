import { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { createApi } from '../src/cli/api.ts'
import { listen } from '../src/cli/dev.ts'
import { checkTopology } from '../src/cli/load.ts'
import { addPlugin, runCommand } from '../src/plugins/commands.ts'
import { applyChanges, checkChanges, diffLines, render } from '../src/plugins/edit.ts'
import { runPlugin, sanitize, type Answer, type Question } from '../src/plugins/host.ts'
import { hashPlugin, readManifest } from '../src/plugins/manifest.ts'
import { expandPatterns } from '../src/plugins/rules.ts'
import { inspect, loadPlugin, readProject, type Resolved } from '../src/plugins/project.ts'
import { checkPatterns, execWarning, matchExec, matchFetch, matchFile } from '../src/plugins/rules.ts'
import { sandboxArgv } from '../src/plugins/sandbox.ts'
import type { CommandResult, LiveData } from '../src/plugins/sdk.ts'

const EXAMPLE = 'examples/acme/topology.yaml'
const PROBE = resolve('tests/fixtures/plugins/probe')
const KUBERNETES = resolve('plugins/kubernetes')

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'malha-plugins-'))
  const file = join(dir, 'topology.yaml')
  copyFileSync(EXAMPLE, file)
  return { dir, file }
}

function resolved(dir: string, options: Record<string, unknown> = {}): Resolved {
  const { manifest, integrity, files } = inspect(dir)
  const { patterns, problems } = expandPatterns(manifest.permissions.fetch, options)
  return { name: manifest.name, dir, builtin: false, manifest: { ...manifest, permissions: { ...manifest.permissions, fetch: patterns } }, integrity, files, entry: { source: dir, options }, warnings: problems }
}

/** Answers every question with the next answer in the list (repeating the last), and records them. */
function asker(...answers: Answer[]) {
  const asked: Question[] = []
  return {
    asked,
    ask: async (q: Question) => {
      asked.push(q)
      return answers[Math.min(asked.length - 1, answers.length - 1)]
    },
  }
}

describe('permission patterns', () => {
  it('matches exec arguments token by token', () => {
    const p = 'kubectl [--context *] get nodes -o json'
    expect(matchExec(p, 'kubectl', ['get', 'nodes', '-o', 'json'])).toBe(true)
    expect(matchExec(p, 'kubectl', ['--context', 'prod', 'get', 'nodes', '-o', 'json'])).toBe(true)
    expect(matchExec(p, 'kubectl', ['get', 'nodes', '-o', 'yaml'])).toBe(false)
    expect(matchExec(p, 'kubectl', ['get', 'nodes', '-o', 'json', '--kubeconfig=/tmp/x'])).toBe(false)
    expect(matchExec(p, 'kubectl', ['--context', '--kubeconfig=/tmp/x', 'get', 'nodes', '-o', 'json'])).toBe(false)
    expect(matchExec(p, '/usr/bin/kubectl', ['get', 'nodes', '-o', 'json'])).toBe(false)
  })

  it('lets * stand for one argument that is not a flag', () => {
    expect(matchExec('echo hello *', 'echo', ['hello', 'world'])).toBe(true)
    expect(matchExec('echo hello *', 'echo', ['hello', '-n'])).toBe(false)
    expect(matchExec('echo hello *', 'echo', ['hello', 'a', 'b'])).toBe(false)
    expect(matchExec('echo hello *', 'echo', ['hello', ''])).toBe(false)
  })

  it('matches fetch by method, exact host, port and path', () => {
    const p = 'https://api.example.com/v1/*'
    expect(matchFetch(p, 'GET', 'https://api.example.com/v1/zones?page=2')).toBe(true)
    expect(matchFetch(p, 'POST', 'https://api.example.com/v1/zones')).toBe(false)
    expect(matchFetch(`POST ${p}`, 'POST', 'https://api.example.com/v1/zones')).toBe(true)
    expect(matchFetch(p, 'GET', 'https://api.example.com.evil.test/v1/x')).toBe(false)
    expect(matchFetch(p, 'GET', 'https://evil.test/https://api.example.com/v1/x')).toBe(false)
    expect(matchFetch(p, 'GET', 'https://user:pw@api.example.com/v1/x')).toBe(false)
    expect(matchFetch(p, 'GET', 'http://api.example.com/v1/x')).toBe(false)
    expect(matchFetch(p, 'GET', 'https://api.example.com:8443/v1/x')).toBe(false)
    expect(matchFetch('https://*.example.com/*', 'GET', 'https://a.b.example.com/x')).toBe(true)
    expect(matchFetch('https://*.example.com/*', 'GET', 'https://notexample.com/x')).toBe(false)
  })

  it('matches files after resolving ~ and ..', () => {
    expect(matchFile('~/.config/acme/token', '~/.config/acme/token')).toBe(true)
    expect(matchFile('~/.config/acme/*', '~/.config/acme/../../.ssh/id_rsa')).toBe(false)
    expect(matchFile('~/.config/acme/*', '~/.config/acme/sub/token')).toBe(false)
    expect(matchFile('~/.config/acme/**', '~/.config/acme/sub/token')).toBe(true)
    expect(matchFile('/etc/hosts', 'relative/hosts')).toBe(false)
  })

  it('rejects malformed patterns and flags open-ended programs', () => {
    expect(checkPatterns({ exec: ['/bin/ls', 'ls ['], fetch: ['ftp://x'], files: ['relative'], env: ['NOT-A-NAME'] })).toHaveLength(5)
    expect(execWarning('bash -c *')).toMatch(/any code/)
    expect(execWarning('kubectl get nodes')).toBeUndefined()
  })
})

describe('plugin folders', () => {
  it('reads a manifest', () => {
    expect(readManifest(PROBE).name).toBe('probe')
    expect(readManifest(KUBERNETES).live?.every).toBe(30)
  })

  it('refuses symlinks, which the permission model would follow', () => {
    const dir = mkdtempSync(join(tmpdir(), 'malha-link-'))
    cpSync(PROBE, dir, { recursive: true })
    symlinkSync('/etc/hostname', join(dir, 'leak'))
    expect(() => hashPlugin(dir)).toThrow(/symlink/)
  })

  it("refuses a name that is one of Malha's commands", () => {
    const dir = mkdtempSync(join(tmpdir(), 'malha-name-'))
    cpSync(PROBE, dir, { recursive: true })
    const manifest = JSON.parse(readFileSync(join(dir, 'malha-plugin.json'), 'utf8'))
    writeFileSync(join(dir, 'malha-plugin.json'), JSON.stringify({ ...manifest, name: 'validate' }))
    expect(() => readManifest(dir)).toThrow(/own commands/)
  })

  it('stops a plugin whose code changed since it was added', async () => {
    const { file } = scratch()
    const dir = mkdtempSync(join(tmpdir(), 'malha-change-'))
    cpSync(PROBE, dir, { recursive: true })
    await addPlugin(file, dir, { yes: true })
    expect(loadPlugin(file, 'probe').integrity).toMatch(/^sha256-/)
    writeFileSync(join(dir, 'index.js'), `${readFileSync(join(dir, 'index.js'), 'utf8')}\n// changed`)
    expect(() => loadPlugin(file, 'probe')).toThrow(/changed since it was added/)
  })

  it('runs plugins under the permission model, reading only their folder and the runtime', () => {
    const argv = sandboxArgv({ wrap: [], network: 'test', strong: false }, PROBE)
    expect(argv).toContain(`--allow-fs-read=${PROBE}`)
    expect(argv.some((a) => a === '--permission' || a === '--experimental-permission')).toBe(true)
    expect(argv.filter((a) => a.startsWith('--allow-')).every((a) => a.startsWith('--allow-fs-read='))).toBe(true)
  })
})

describe('editing the topology', () => {
  const text = readFileSync(EXAMPLE, 'utf8')

  it('changes values in place, in the style around them', () => {
    const { ok } = checkChanges([
      { update: 'nodes', id: 'w1', set: { 'usage.pods': 99, 'usage.sampled': '2026-10-25' } },
      { update: 'nodes', id: 'w3', set: { tags: ['new'] } },
      { update: 'apps', id: 'shop', set: { pods: { w1: 1 } } },
      { meta: { pods_sampled: '2026-10-25' } },
    ])
    const r = applyChanges(text, ok, '2026-10-25')
    expect(r.problems).toEqual([])
    expect(r.text).toContain('usage: { cpu_pct: 14, memory_pct: 38, pods: 99, sampled: 2026-10-25 }')
    expect(r.text).toContain('pods: { w1: 1 }')
    expect(r.text).toMatch(/\n    tags: \[new\]\n/)
    // Three lines replaced and one added; nothing else moved.
    expect(diffLines(text, r.text).filter((l) => l.startsWith('+') || l.startsWith('-'))).toHaveLength(7)
    expect(checkTopology(r.text).errors).toEqual([])
  })

  it('adds items in the style of the list', () => {
    const { ok } = checkChanges([
      { add: 'nodes', item: { id: 'w4', name: 'worker-4', kind: 'worker', zone: 'workers', usage: { pods: 1 } } },
      { add: 'domains', item: { name: 'acme-new.example', notes: 'has # a hash' } },
    ])
    const r = applyChanges(text, ok, '2026-10-25')
    expect(r.text).toMatch(/\n  - id: w4\n    name: worker-4\n    kind: worker\n    zone: workers\n    usage: \{ pods: 1 \}\n/)
    // The domain list is sorted, so the new one goes in order, not at the end.
    expect(r.text).toContain('  list:\n    - { name: acme-new.example, notes: "has # a hash" }\n    - { name: acme-old.example')
    expect((parse(r.text) as { domains: { list: { notes?: string }[] } }).domains.list[0].notes).toBe('has # a hash')
  })

  it('refuses bad changes and keeps the good ones', () => {
    const { ok, problems } = checkChanges([
      { update: 'nodes', id: 'w1', set: { id: 'x' } },
      { update: 'nodes', id: 'w1', set: { 'usage.__proto__.polluted': 1 } },
      { update: 'nodes', id: 'w1', set: { notes: null } },
      { update: 'links', id: 'x', set: { a: 1 } },
      { add: 'nodes', item: { name: 'no id' } },
      { update: 'nodes', id: 'missing', set: { 'usage.pods': 1 } },
      { add: 'nodes', item: { id: 'w1', name: 'duplicate', kind: 'worker', zone: 'workers' } },
      { update: 'nodes', id: 'w2', set: { 'usage.pods': 1 } },
    ])
    expect(problems).toHaveLength(5)
    const r = applyChanges(text, ok, '2026-10-25')
    expect(r.applied.map((a) => a.summary)).toEqual(['update nodes w2: usage.pods'])
    expect(r.problems).toHaveLength(2)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('skips changes that alter nothing', () => {
    const r = applyChanges(text, checkChanges([{ update: 'nodes', id: 'w1', set: { 'usage.pods': 94 } }]).ok, '2026-10-25')
    expect(r.applied).toEqual([])
    expect(r.text).toBe(text)
  })

  it('quotes only what would not read back the same', () => {
    expect(render(['2026-10-25', '110', 'yes', 'a: b', 'plain text', '*.example.com'])).toBe('[2026-10-25, "110", yes, "a: b", plain text, "*.example.com"]')
  })

  it('diffs with context', () => {
    expect(diffLines('a\nb\nc\nd\ne', 'a\nb\nX\nd\ne', 1)).toEqual(['@@ -2,3 +2,3 @@', ' b', '-c', '+X', ' d'])
  })
})

describe('the sandbox', () => {
  let server: Server
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => res.end(req.url === '/secret' ? 'SECRET' : `got ${req.method} ${body}`))
    })
    await new Promise<void>((r) => server.listen(5491, '127.0.0.1', r))
  })
  afterAll(() => server.close())

  it('blocks every way out that does not go through Malha', async () => {
    const { file } = scratch()
    const r = (await runPlugin({ file, plugin: resolved(PROBE), run: { kind: 'command', name: 'escape' }, asker: asker('once') })) as CommandResult
    const results = JSON.parse(r.message!) as Record<string, string>
    for (const [attempt, outcome] of Object.entries(results)) expect(outcome, attempt).toMatch(/^blocked/)
  })

  it('asks once per pattern, and passes allowed calls through', async () => {
    const { file } = scratch()
    process.env.MALHA_PROBE_TOKEN = 'tok-1'
    const a = asker('once')
    const out: string[] = []
    const r = (await runPlugin({ file, plugin: resolved(PROBE, { a: 1 }), run: { kind: 'command', name: 'allowed' }, args: ['x'], asker: a, output: (l) => out.push(l) })) as CommandResult
    expect(JSON.parse(r.message!)).toEqual({ echo: 'hello --loud world', token: 'tok-1', nodes: 14, fetched: '200 got POST hi', args: ['x'], options: { a: 1 } })
    expect(a.asked.map((q) => `${q.kind}: ${q.detail}`)).toEqual(['exec: echo hello --loud world', 'env: MALHA_PROBE_TOKEN', 'fetch: POST http://127.0.0.1:5491/ok/ping'])
    // Escape sequences cannot redraw the terminal.
    expect(out).toEqual(['fake prompt? 1. Yes'])
  })

  it('refuses undeclared calls without asking', async () => {
    const { file } = scratch()
    const a = asker('once')
    const r = (await runPlugin({ file, plugin: resolved(PROBE), run: { kind: 'command', name: 'undeclared' }, asker: a })) as CommandResult
    expect(r.message).toBe('blocked MALHA_DENIED | blocked MALHA_DENIED')
    expect(a.asked).toEqual([])
  })

  it('remembers "always" until the code changes, and logs every decision', async () => {
    const { file } = scratch()
    const first = asker('always')
    await runPlugin({ file, plugin: resolved(PROBE), run: { kind: 'command', name: 'allowed' }, asker: first })
    expect(first.asked).toHaveLength(3)
    const second = asker('deny')
    await runPlugin({ file, plugin: resolved(PROBE), run: { kind: 'command', name: 'allowed' }, asker: second })
    expect(second.asked).toEqual([])

    const changed = mkdtempSync(join(tmpdir(), 'malha-changed-'))
    cpSync(PROBE, changed, { recursive: true })
    writeFileSync(join(changed, 'README'), 'new code')
    const third = asker('deny')
    await expect(runPlugin({ file, plugin: resolved(changed), run: { kind: 'command', name: 'allowed' }, asker: third })).rejects.toThrow(/declined/)
    expect(third.asked).toHaveLength(1)

    const log = readFileSync(join(file, '..', '.malha', 'plugins.log'), 'utf8')
    expect(log).toContain('"decision":"asked:always"')
    expect(log).toContain('"decision":"denied"')
  })

  it('stops a plugin that runs too long', async () => {
    const { file } = scratch()
    await expect(runPlugin({ file, plugin: resolved(PROBE), run: { kind: 'command', name: 'hang' }, asker: asker('once'), timeoutMs: 1500 })).rejects.toThrow(/longer than/)
  })

  it('writes proposals only with a yes, and checks them first', async () => {
    const { file } = scratch()
    await addPlugin(file, PROBE, { yes: true })
    expect(readProject(file).plugins.probe.integrity).toMatch(/^sha256-/)
    const before = readFileSync(file, 'utf8')
    await runCommand(file, 'probe', 'propose', { args: [], yes: false, dryRun: true })
    expect(readFileSync(file, 'utf8')).toBe(before)
    await runCommand(file, 'probe', 'propose', { args: [], yes: true, dryRun: false })
    expect(readFileSync(file, 'utf8')).toContain('usage: { cpu_pct: 14, memory_pct: 38, pods: 42, sampled: 2026-10-01 }')
  })
})

describe('the kubernetes plugin', () => {
  const path = process.env.PATH
  beforeAll(() => {
    process.env.PATH = `${resolve('tests/fixtures/bin')}${delimiter}${path}`
  })
  afterAll(() => {
    process.env.PATH = path
  })

  it('proposes what the cluster has and the file lacks', async () => {
    const { file } = scratch()
    const r = (await runPlugin({ file, plugin: resolved(KUBERNETES), run: { kind: 'command', name: 'import' }, asker: asker('once') })) as CommandResult
    expect(r.message).toContain('Cluster acme-test: 4 nodes, 9 pods in 6 namespaces, 3 ingresses.')
    expect(r.message).toContain('in the file, not in the cluster: cp2')
    const { ok, problems } = checkChanges(r.changes)
    expect(problems).toEqual([])
    const p = applyChanges(readFileSync(file, 'utf8'), ok, '2026-10-25')
    expect(p.problems).toEqual([])
    expect(checkTopology(p.text).errors).toEqual([])
    const t = parse(p.text) as { nodes: { id: string; status?: string; usage?: Record<string, unknown>; zone: string; addresses?: Record<string, string> }[]; apps: { id: string; namespace?: string; pods?: Record<string, number>; domains?: string[] }[]; meta: Record<string, string>; domains: { list: { name: string }[] } }
    const node = (id: string) => t.nodes.find((n) => n.id === id)!
    const app = (id: string) => t.apps.find((a) => a.id === id)!
    // Matched by name, by address; drafted when missing.
    expect(node('w1').usage).toMatchObject({ cpu_pct: 7, memory_pct: 31, pods: 5 })
    expect(node('w2')).toMatchObject({ status: 'degraded', usage: { cpu_pct: 5, memory_pct: 23, pods: 1 } })
    expect(node('worker-4')).toMatchObject({ kind: 'worker', zone: 'workers', addresses: { public: '203.0.113.24', internal: '10.10.0.24' } })
    // Pods per app by namespace, or by id when the app names no namespace; unscheduled pods skipped.
    expect(app('shop').pods).toEqual({ w1: 2, w2: 1, 'worker-4': 1 })
    expect(app('status').pods).toEqual({ w1: 1 })
    expect(app('admin').pods).toEqual({})
    expect(app('shop').domains).toContain('beta.shop.acme.example')
    expect(t.apps.find((a) => a.id === 'ingress-nginx')).toBeTruthy()
    expect(t.apps.find((a) => a.id === 'kube-system')).toBeUndefined()
    expect(t.meta).toMatchObject({ kubernetes: 'v1.35.4', pods_sampled: expect.any(String) })
    expect(t.domains.list.map((d) => d.name)).toContain('acme-new.example')
  })

  it('counts every namespace of an app that lists several', async () => {
    const { file } = scratch()
    writeFileSync(file, readFileSync(file, 'utf8').replace('    namespace: api\n', '    namespace: [api, ingress-nginx]\n'))
    expect(checkTopology(readFileSync(file, 'utf8')).errors).toEqual([])
    const r = (await runPlugin({ file, plugin: resolved(KUBERNETES), run: { kind: 'command', name: 'import' }, asker: asker('once') })) as CommandResult
    expect(r.changes!.find((c) => 'update' in c && c.id === 'api')).toMatchObject({ set: { pods: { w1: 1, 'worker-4': 1 } }, why: 'namespace api, ingress-nginx' })
    expect(r.changes!.some((c) => 'add' in c && c.add === 'apps' && c.item.id === 'ingress-nginx')).toBe(false)
  })

  it('finds an app by the hostnames it lists when its id is not its namespace', async () => {
    const { file } = scratch()
    writeFileSync(file, readFileSync(file, 'utf8').replace('    namespace: admin\n', ''))
    const r = (await runPlugin({ file, plugin: resolved(KUBERNETES), run: { kind: 'command', name: 'import' }, asker: asker('once') })) as CommandResult
    expect(r.changes!.find((c) => 'update' in c && c.id === 'admin')).toMatchObject({ set: { namespace: 'backoffice', pods: { w1: 1 } } })
    expect(r.changes!.some((c) => 'add' in c && c.add === 'apps' && c.item.id === 'backoffice')).toBe(false)
  })

  it('only updates with --no-add, and honours ignore_namespaces', async () => {
    const { file } = scratch()
    const r = (await runPlugin({ file, plugin: resolved(KUBERNETES, { ignore_namespaces: ['ingress-nginx'] }), run: { kind: 'command', name: 'import' }, args: ['--no-add'], asker: asker('once') })) as CommandResult
    expect(r.changes!.some((c) => 'add' in c)).toBe(false)
    expect(r.message).toContain('not in the file: node worker-4')
    expect(r.message).not.toContain('ingress-nginx')
  })

  it('reports live usage for the nodes in the file', async () => {
    const { file } = scratch()
    const r = (await runPlugin({ file, plugin: resolved(KUBERNETES), run: { kind: 'live' }, asker: asker('once') })) as LiveData
    expect(r.nodes).toEqual({
      w1: { cpu_pct: 7, memory_pct: 31, pods: 5, status: 'active' },
      w2: { cpu_pct: 5, memory_pct: 23, pods: 1, status: 'degraded' },
      cp1: { cpu_pct: 8, memory_pct: 37, pods: 1, status: 'active' },
    })
  })
})

describe('malha dev', () => {
  it('reports the port it really got when the asked one is taken', async () => {
    const taken = createServer()
    await new Promise<void>((r) => taken.listen(0, '127.0.0.1', r))
    const busy = (taken.address() as AddressInfo).port
    const server = createServer()
    expect(await listen(server, busy, '127.0.0.1')).toBe(busy + 1)
    server.close()
    taken.close()
  })

  it('takes answers only from its own page, through a local address', async () => {
    const { file } = scratch()
    await addPlugin(file, PROBE, { yes: true })
    const api = createApi(file, { plugins: true, loopback: true, log: () => undefined })
    const server = createServer((req, res) => api.handle(req, res) || res.writeHead(404).end())
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    const token = /content="([^"]+)"/.exec(api.injectToken('<head></head>'))![1]
    const post = (headers: Record<string, string>, body: unknown) =>
      new Promise<number>((done) => {
        const req = request({ host: '127.0.0.1', port, path: '/api/answer', method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
          res.resume()
          done(res.statusCode!)
        })
        req.end(JSON.stringify(body))
      })
    try {
      // The probe's live() runs echo, which needs a yes.
      let id: string | undefined
      for (let i = 0; i < 100 && !id; i++) {
        id = api && (JSON.parse(await (await fetch(`http://127.0.0.1:${port}/api/live.json`)).text()) as { asks: { id: string }[] }).asks[0]?.id
        if (!id) await new Promise((r) => setTimeout(r, 50))
      }
      expect(id).toBeTruthy()
      const good = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'x-malha-token': token }
      expect(await post({ ...good, 'x-malha-token': 'nope' }, { id, answer: 'once' })).toBe(403)
      expect(await post({ ...good, origin: 'http://evil.test' }, { id, answer: 'once' })).toBe(403)
      expect(await post({ ...good, host: 'evil.test' }, { id, answer: 'once' })).toBe(403)
      expect(await post(good, { id, answer: 'sure' })).toBe(400)
      expect(await post(good, { id, answer: 'once' })).toBe(200)
      let nodes: Record<string, unknown> = {}
      for (let i = 0; i < 100 && !Object.keys(nodes).length; i++) {
        nodes = (JSON.parse(await (await fetch(`http://127.0.0.1:${port}/api/live.json`)).text()) as { nodes: Record<string, unknown> }).nodes
        if (!Object.keys(nodes).length) await new Promise((r) => setTimeout(r, 50))
      }
      expect(nodes.w1).toMatchObject({ cpu_pct: 10, pods: 30, plugin: 'probe' })
    } finally {
      api.close()
      server.close()
    }
  })
})

describe('sanitize', () => {
  it('drops escape sequences and control characters', () => {
    expect(sanitize('\x1b[2J\x1b[Hhi\x07 \x1b]0;title\x07there\r')).toBe('hi there')
  })
})

it('ships the kubernetes plugin with no install step', () => {
  expect(existsSync(join(KUBERNETES, 'node_modules'))).toBe(false)
})
