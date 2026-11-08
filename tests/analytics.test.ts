import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { analytics, cleanResults, readAnalytics, refreshAnalytics } from '../src/cli/analytics.ts'
import { loadTopology } from '../src/cli/load.ts'
import { scan, findTrackers } from '../src/cli/trackers.ts'
import { ranges, type AnalyticsCache, type AnalyticsRequest, type SourceResult } from '../src/core/analytics.ts'
import { runChecks } from '../src/core/check.ts'
import type { Topology } from '../src/core/types.ts'
import { addPlugin, allowPlugin } from '../src/plugins/commands.ts'
import { runPlugin, type Answer, type Question } from '../src/plugins/host.ts'
import { inspect, loadPlugin, readProject, writeProject, type Resolved } from '../src/plugins/project.ts'
import { checkPatterns, expandPatterns } from '../src/plugins/rules.ts'
import type { LinkResult } from '../src/plugins/sdk.ts'

const EXAMPLE = 'examples/acme/topology.yaml'
const UUID = '7b8f1c2e-5a44-4d1e-9c3a-2f6e8d0b1a55'

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'malha-analytics-'))
  const file = join(dir, 'topology.yaml')
  copyFileSync(EXAMPLE, file)
  return { dir, file }
}

function resolved(name: string, options: Record<string, unknown> = {}): Resolved {
  const dir = resolve(`plugins/${name}`)
  const { manifest, integrity, files } = inspect(dir)
  const { patterns, problems } = expandPatterns(manifest.permissions.fetch, options)
  return { name, dir, builtin: true, manifest: { ...manifest, permissions: { ...manifest.permissions, fetch: patterns } }, integrity, files, entry: { source: `builtin:${name}`, options }, warnings: problems }
}

const yes = { ask: async (_q: Question): Promise<Answer> => 'once' }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const req = (sources: AnalyticsRequest['sources'], days = 3): AnalyticsRequest => ({ ...ranges(days, new Date('2026-11-04T12:00:00Z')), timezone: 'UTC', sources })

afterEach(() => {
  vi.unstubAllGlobals()
  for (const k of ['UMAMI_USERNAME', 'UMAMI_PASSWORD', 'UMAMI_API_KEY', 'POSTHOG_PERSONAL_API_KEY', 'GOOGLE_SERVICE_ACCOUNT']) delete process.env[k]
})

describe('hosts from options', () => {
  it('fills {options.key} with one origin or a list, and refuses anything else', () => {
    expect(expandPatterns(['GET {options.hosts}/api/*', 'GET https://fixed.example/*'], { hosts: ['https://a.example', 'http://b.example:8080/'] }).patterns).toEqual([
      'GET https://a.example/api/*',
      'GET http://b.example:8080/api/*',
      'GET https://fixed.example/*',
    ])
    const bad = expandPatterns(['GET {options.hosts}/api/*'], { hosts: ['https://a.example/sub', 'https://*.example', 'https://u:p@a.example', 'ftp://a.example', 42] })
    expect(bad.patterns).toEqual([])
    expect(bad.problems).toHaveLength(5)
    expect(expandPatterns(['GET {options.hosts}/api/*'], {}).problems).toEqual(['GET {options.hosts}/api/*: set options.hosts in malha.plugins.json'])
  })

  it('only allows the template as the whole host', () => {
    expect(checkPatterns({ fetch: ['GET,POST {options.hosts}/api/*'] })).toEqual([])
    expect(checkPatterns({ fetch: ['GET https://{options.sub}.example.com/*'] })[0]).toMatch(/whole host/)
  })

  it('expands them when a plugin loads, and says what is missing', async () => {
    const { file } = scratch()
    await addPlugin(file, 'umami', { yes: true })
    expect(loadPlugin(file, 'umami').warnings[0]).toMatch(/set options.hosts/)
    const project = readProject(file)
    project.plugins.umami.options = { hosts: ['https://u.acme.example'] }
    writeProject(file, project)
    expect(loadPlugin(file, 'umami').manifest.permissions.fetch).toEqual(['GET,POST https://u.acme.example/api/*', 'GET https://u.acme.example/v1/*'])
  })
})

describe('finding trackers', () => {
  it('reads Umami, GA4, Tag Manager and PostHog from a page or a script', () => {
    const html = `<script defer src="/u/script.js" data-website-id="${UUID}"></script>
      <script async src="https://www.googletagmanager.com/gtag/js?id=G-ABCDEF1234"></script>
      <script src="https://www.googletagmanager.com/gtm.js?id=GTM-K9X2"></script>
      <p>Order G-20010904 shipped</p>`
    const found = scan(html, 'https://shop.acme.example/')
    expect(found.umami).toEqual([{ website: UUID, script: 'https://shop.acme.example/u/script.js' }])
    expect([...found.ga4]).toEqual(['G-ABCDEF1234'])
    expect([...found.gtm]).toEqual(['GTM-K9X2'])
    const bundle = scan(`posthog.init("phc_${'a'.repeat(43)}",{api_host:"https://eu.i.posthog.com"});gtag("config","G-ZZZZ99ZZZZ");x({gaId:"G-NEXTJS1234"})`, 'https://x/')
    expect(bundle.posthog).toEqual([{ key: `phc_${'a'.repeat(43)}`, host: 'https://eu.i.posthog.com' }])
    expect([...bundle.ga4]).toEqual(['G-ZZZZ99ZZZZ', 'G-NEXTJS1234'])
  })

  it('loads each app’s home page and its own scripts', async () => {
    const fetched: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      fetched.push(url)
      if (url === 'https://acme.example/') return new Response('<html><script src="/_next/app.js"></script><script src="https://cdn.other.example/x.js"></script></html>')
      if (url === 'https://acme.example/_next/app.js') return new Response(`posthog.init('phc_${'b'.repeat(43)}', { api_host: 'https://us.i.posthog.com' })`)
      return new Response('', { status: 404 })
    })
    const t = loadTopology(EXAMPLE).data!
    const trackers = await findTrackers({ ...t, apps: t.apps!.filter((a) => a.id === 'shop') })
    expect(trackers[0].posthog[0].host).toBe('https://us.i.posthog.com')
    expect(fetched).not.toContain('https://cdn.other.example/x.js')
  })
})

describe('the umami plugin', () => {
  it('logs in to a server and reads Umami 3 numbers, with zero days filled in', async () => {
    process.env.UMAMI_USERNAME = 'malha'
    process.env.UMAMI_PASSWORD = 'pw'
    const { file } = scratch()
    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const u = new URL(url)
      calls.push(`${init.method ?? 'GET'} ${u.pathname}${u.searchParams.get('type') ? `?type=${u.searchParams.get('type')}` : ''}`)
      if (u.pathname === '/api/auth/login') return json({ token: 'jwt' })
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer jwt')
      if (u.pathname.endsWith('/stats')) return json(Number(u.searchParams.get('startAt')) < Date.parse('2026-11-01') ? { pageviews: 50, visitors: 20, visits: 25, bounces: 5, totaltime: 500 } : { pageviews: 90, visitors: 30, visits: 40, bounces: 10, totaltime: 1200 })
      if (u.pathname.endsWith('/pageviews')) return json({ pageviews: [{ x: '2026-11-01 00:00:00', y: 40 }, { x: '2026-11-03 00:00:00', y: 50 }], sessions: [{ x: '2026-11-01 00:00:00', y: 12 }] })
      if (u.pathname.endsWith('/metrics')) return u.searchParams.get('type') === 'path' ? json({}, 400) : json([{ x: '/', y: 70 }])
      return json({}, 404)
    })
    const r = (await runPlugin({ file, plugin: resolved('umami', { hosts: ['https://u.acme.example'] }), run: { kind: 'analytics' }, input: req([{ app: 'status', provider: 'umami', id: UUID, hostnames: [] }]), asker: yes })) as { results: SourceResult[] }
    expect(r.results[0]).toMatchObject({ ok: true, totals: { visitors: 30, pageviews: 90, sessions: 40, bounce_rate: 0.25, avg_duration: 30 }, previous: { visitors: 20 } })
    expect(r.results[0].series).toEqual([
      { date: '2026-11-01', visitors: 12, pageviews: 40 },
      { date: '2026-11-02', visitors: 0, pageviews: 0 },
      { date: '2026-11-03', visitors: 0, pageviews: 50 },
    ])
    // Umami 2 says "url" where 3 says "path".
    expect(r.results[0].top?.pages).toEqual([{ key: '/', value: 70 }])
    expect(calls).toContain('GET /api/websites/' + UUID + '/metrics?type=url')
  })

  it('reads Umami 2 numbers and Umami Cloud with an API key', async () => {
    process.env.UMAMI_API_KEY = 'cloud-key'
    const { file } = scratch()
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      expect(url.startsWith('https://api.umami.is/v1/')).toBe(true)
      expect(new Headers(init.headers).get('x-umami-api-key')).toBe('cloud-key')
      if (url.includes('/stats')) return json({ pageviews: { value: 10, prev: 1 }, visitors: { value: 4, prev: 1 }, visits: { value: 5, prev: 1 }, bounces: { value: 1, prev: 0 }, totaltime: { value: 100, prev: 0 } })
      if (url.includes('/pageviews')) return json({ pageviews: [], sessions: [] })
      return json([])
    })
    const r = (await runPlugin({ file, plugin: resolved('umami', { hosts: ['https://api.umami.is'] }), run: { kind: 'analytics' }, input: req([{ app: 'status', provider: 'umami', id: UUID, hostnames: [] }]), asker: yes })) as { results: SourceResult[] }
    expect(r.results[0].totals).toMatchObject({ visitors: 4, pageviews: 10, sessions: 5 })
  })
})

describe('the posthog plugin', () => {
  it('counts pageviews on the app’s own hostnames, wildcards included', async () => {
    process.env.POSTHOG_PERSONAL_API_KEY = 'phx_key'
    const { file } = scratch()
    const queries: string[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      expect(url).toBe('https://eu.posthog.com/api/projects/4242/query/')
      const q = JSON.parse(String(init.body)).query.query as string
      queries.push(q)
      if (q.includes('count(DISTINCT properties.$session_id)')) return json({ results: [[q.includes('2026-10-29') ? 9 : 21, 60, 25]] })
      if (q.includes('toDate(timestamp)')) return json({ results: [['2026-11-02', 7, 20]] })
      return json({ results: [['/orders', 33]] })
    })
    const r = (await runPlugin({ file, plugin: resolved('posthog', { hosts: ['https://eu.posthog.com'] }), run: { kind: 'analytics' }, input: req([{ app: 'admin', provider: 'posthog', id: 4242, hostnames: ['admin.acme.example', '*.shop.acme.example', "x'; DROP"] }]), asker: yes })) as { results: SourceResult[] }
    expect(r.results[0]).toMatchObject({ ok: true, totals: { visitors: 21, pageviews: 60, sessions: 25 }, previous: { visitors: 9 } })
    expect(r.results[0].series?.[1]).toEqual({ date: '2026-11-02', visitors: 7, pageviews: 20 })
    expect(queries[0]).toContain("properties.$host IN ('admin.acme.example')")
    expect(queries[0]).toContain("endsWith(properties.$host, '.shop.acme.example')")
    expect(queries.join('\n')).not.toContain('DROP')
  })
})

describe('the posthog plugin finds projects', () => {
  it('in every organization, also behind a reverse proxy', async () => {
    process.env.POSTHOG_PERSONAL_API_KEY = 'phx_key'
    const { file } = scratch()
    const KEY = `phc_${'k'.repeat(43)}`
    vi.stubGlobal('fetch', async (url: string) => {
      const u = new URL(url)
      expect(u.origin).toBe('https://us.posthog.com')
      if (u.pathname === '/api/projects/') return json({ results: [{ id: 1, api_token: 'phc_current' }] })
      if (u.pathname === '/api/organizations/') return json({ results: [{ id: 'org-a', name: 'A' }, { id: 'org-b', name: 'B' }] })
      if (u.pathname === '/api/organizations/org-a/projects/') return json({ results: [{ id: 1, api_token: 'phc_current' }] })
      if (u.pathname === '/api/organizations/org-b/projects/') return json({ results: [{ id: 77, api_token: KEY }] })
      return json({}, 404)
    })
    const none = { umami: [], ga4: [], gtm: [] }
    const trackers = [
      // Sends through its own domain, so the page doesn't say which PostHog it is.
      { app: 'admin', hostnames: ['admin.acme.example'], ...none, posthog: [{ key: KEY, host: 'https://admin.acme.example' }] },
      { app: 'shop', hostnames: ['acme.example'], ...none, posthog: [{ key: `phc_${'z'.repeat(43)}` }] },
    ]
    const r = (await runPlugin({ file, plugin: resolved('posthog', { hosts: ['https://us.posthog.com'] }), run: { kind: 'link' }, input: { trackers }, asker: yes })) as LinkResult
    expect(r.sources).toEqual([{ app: 'admin', source: { provider: 'posthog', id: 77 } }])
    expect(r.notes).toEqual([`shop: no project with the key phc_zzzzzz… on https://us.posthog.com`])
  })

  it('says when the key cannot list organizations', async () => {
    process.env.POSTHOG_PERSONAL_API_KEY = 'phx_key'
    const { file } = scratch()
    vi.stubGlobal('fetch', async (url: string) => (new URL(url).pathname === '/api/projects/' ? json({ results: [{ id: 5, api_token: 'phc_current' }] }) : json({ detail: 'scope' }, 403)))
    const r = (await runPlugin({ file, plugin: resolved('posthog', { hosts: ['https://us.posthog.com'] }), run: { kind: 'link' }, input: { trackers: [{ app: 'admin', hostnames: [], umami: [], ga4: [], gtm: [], posthog: [{ key: 'phc_current' }] }] }, asker: yes })) as LinkResult
    expect(r.sources).toEqual([{ app: 'admin', source: { provider: 'posthog', id: 5 } }])
    expect(r.notes?.[0]).toMatch(/403 for \/api\/organizations\/: only the key's current organization was searched/)
  })
})

describe('the google plugin', () => {
  async function serviceAccount() {
    const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
    const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64')
    process.env.GOOGLE_SERVICE_ACCOUNT = JSON.stringify({ client_email: 'malha@acme.iam.gserviceaccount.com', private_key: `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n` })
    return pair.publicKey
  }
  /** A token endpoint that checks the JWT's signature, scopes and audience. */
  const tokenEndpoint = (publicKey: CryptoKey) => async (body: string) => {
    const assertion = new URLSearchParams(body).get('assertion')!
    const [head, claims, sig] = assertion.split('.')
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, Buffer.from(sig, 'base64url'), new TextEncoder().encode(`${head}.${claims}`))
    const c = JSON.parse(Buffer.from(claims, 'base64url').toString())
    return valid && c.aud === 'https://oauth2.googleapis.com/token' && c.scope.includes('analytics.readonly') && c.scope.includes('webmasters.readonly') ? json({ access_token: 'goog' }) : json({ error: 'invalid_grant' }, 400)
  }

  it('signs its own token and reads GA4 and Search Console', async () => {
    const publicKey = await serviceAccount()
    const token = tokenEndpoint(publicKey)
    const { file } = scratch()
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (url === 'https://oauth2.googleapis.com/token') return token(String(init.body))
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer goog')
      if (url.endsWith(':batchRunReports'))
        return json({
          reports: [
            { rows: [{ dimensionValues: [{ value: 'now' }], metricValues: ['300', '900', '400', '0.4', '61'].map((value) => ({ value })) }, { dimensionValues: [{ value: 'before' }], metricValues: ['200', '600', '250', '0.5', '50'].map((value) => ({ value })) }] },
            { rows: [{ dimensionValues: [{ value: '20261102' }], metricValues: [{ value: '120' }, { value: '330' }] }] },
            { rows: [{ dimensionValues: [{ value: '/' }], metricValues: [{ value: '500' }] }] },
            { rows: [] },
            { rows: [] },
          ],
        })
      if (url.endsWith(':runReport')) return json({ rows: [{ dimensionValues: [{ value: 'mobile' }], metricValues: [{ value: '200' }] }] })
      if (url.includes('/searchAnalytics/query')) {
        expect(url).toContain('/sites/sc-domain%3Aacme.example/')
        const dims = JSON.parse(String(init.body)).dimensions
        return json({ rows: dims.length ? [{ keys: [dims[0] === 'date' ? '2026-11-02' : 'acme kettle'], clicks: 9, impressions: 100, ctr: 0.09, position: 3 }] : [{ clicks: 40, impressions: 900, ctr: 0.044, position: 7.5 }] })
      }
      return json({}, 404)
    })
    const r = (await runPlugin({
      file,
      plugin: resolved('google'),
      run: { kind: 'analytics' },
      input: req([
        { app: 'shop', provider: 'ga4', id: 'properties/312345678', hostnames: [] },
        { app: 'shop', provider: 'search-console', id: 'sc-domain:acme.example', hostnames: [] },
      ]),
      asker: yes,
    })) as { results: SourceResult[] }
    expect(r.results[0]).toMatchObject({ ok: true, totals: { visitors: 300, pageviews: 900, sessions: 400, bounce_rate: 0.4 }, previous: { visitors: 200 }, top: { pages: [{ key: '/', value: 500 }], devices: [{ key: 'mobile', value: 200 }] } })
    expect(r.results[0].series?.find((p) => p.date === '2026-11-02')).toEqual({ date: '2026-11-02', visitors: 120, pageviews: 330 })
    expect(r.results[1]).toMatchObject({ ok: true, search: { totals: { clicks: 40, position: 7.5 }, queries: [{ key: 'acme kettle', clicks: 9 }] } })
  })

  it('matches measurement ids to properties, and Search Console properties to apps', async () => {
    const publicKey = await serviceAccount()
    const token = tokenEndpoint(publicKey)
    const { file } = scratch()
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (url === 'https://oauth2.googleapis.com/token') return token(String(init.body))
      if (url.includes('/accountSummaries')) return json({ accountSummaries: [{ propertySummaries: [{ property: 'properties/312345678' }] }] })
      if (url.includes('/dataStreams')) return json({ dataStreams: [{ webStreamData: { measurementId: 'G-ABCDEF1234' } }] })
      if (url.endsWith('/webmasters/v3/sites')) return json({ siteEntry: [{ siteUrl: 'sc-domain:acme.example', permissionLevel: 'siteRestrictedUser' }, { siteUrl: 'https://other.example/', permissionLevel: 'siteOwner' }] })
      return json({}, 404)
    })
    const t = loadTopology(EXAMPLE).data!
    const trackers = t.apps!.map((a) => ({ app: a.id, hostnames: a.domains ?? [], umami: [], ga4: a.id === 'shop' ? ['G-ABCDEF1234'] : a.id === 'api' ? ['G-NOTVISIBLE'] : [], gtm: [], posthog: [] }))
    const r = (await runPlugin({ file, plugin: resolved('google'), run: { kind: 'link' }, input: { trackers }, asker: yes })) as LinkResult
    expect(r.sources).toEqual([
      { app: 'shop', source: { provider: 'ga4', id: '312345678' } },
      { app: 'shop', source: { provider: 'search-console', id: 'sc-domain:acme.example' } },
    ])
    expect(r.notes?.join('\n')).toContain('G-NOTVISIBLE')
  })
})

describe('malha analytics', () => {
  function umamiServer() {
    vi.stubGlobal('fetch', async (url: string) => {
      const u = new URL(url)
      if (u.hostname === 'status.acme-status.example') return new Response(`<script defer src="https://u.acme.example/script.js" data-website-id="${UUID}"></script>`)
      if (u.hostname !== 'u.acme.example') return new Response('', { status: 404 })
      if (u.pathname === '/api/auth/login') return json({ token: 't' })
      if (u.pathname === `/api/websites/${UUID}`) return json({ id: UUID })
      if (u.pathname.endsWith('/stats')) return json({ pageviews: 100, visitors: 40, visits: 50, bounces: 10, totaltime: 900 })
      if (u.pathname.endsWith('/pageviews')) return json({ pageviews: [], sessions: [] })
      return json([])
    })
  }
  async function project() {
    process.env.UMAMI_USERNAME = 'malha'
    process.env.UMAMI_PASSWORD = 'pw'
    const { file } = scratch()
    await addPlugin(file, 'umami', { yes: true })
    const p = readProject(file)
    p.plugins.umami.options = { hosts: ['https://u.acme.example'] }
    writeProject(file, p)
    await allowPlugin(file, 'umami', { yes: true })
    return file
  }

  it('detect finds the tracker on the page and proposes the source', async () => {
    const file = await project()
    const before = parse(readFileSync(file, 'utf8')) as Topology
    expect(before.apps!.find((a) => a.id === 'status')!.analytics).toEqual([{ provider: 'umami', id: UUID }])
    // Start without it: detect should add it back.
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, readFileSync(file, 'utf8').replace(`    analytics:\n      - { provider: umami, id: ${UUID} }\n`, ''))
    umamiServer()
    await analytics(file, 'detect', { days: 30, timezone: 'UTC', yes: true, dryRun: false })
    const after = parse(readFileSync(file, 'utf8')) as Topology
    expect(after.apps!.find((a) => a.id === 'status')!.analytics).toEqual([{ provider: 'umami', id: UUID }])
  })

  it('refresh writes every source, and says which have no plugin', async () => {
    const file = await project()
    umamiServer()
    const cache = await refreshAnalytics(file, { days: 7, timezone: 'UTC', asker: yes, log: () => undefined })
    expect(readAnalytics(file)?.fetched).toBe(cache.fetched)
    expect(cache.results.find((r) => r.provider === 'umami')).toMatchObject({ app: 'status', ok: true, totals: { visitors: 40 } })
    expect(cache.results.find((r) => r.provider === 'ga4')).toMatchObject({ ok: false, error: expect.stringContaining('malha plugin add google') })
    expect(cache.results.find((r) => r.provider === 'posthog')).toMatchObject({ ok: false, error: expect.stringContaining('malha plugin add posthog') })
  })

  it('keeps only what was asked for, in bounds', () => {
    const request = req([{ app: 'shop', provider: 'ga4', id: '1', hostnames: [] }])
    const out = cleanResults({ results: [{ app: 'shop', provider: 'ga4', id: '1', ok: true, totals: { visitors: -5, pageviews: 1e3, bounce_rate: 7 }, series: [{ date: 'nope' }, { date: '2026-11-02', visitors: 3 }] }, { app: 'other', provider: 'ga4', id: '9', ok: true }] }, request)
    expect(out).toEqual([{ app: 'shop', provider: 'ga4', id: '1', host: undefined, primary: undefined, ok: true, error: undefined, totals: { visitors: undefined, pageviews: 1000, sessions: undefined, bounce_rate: undefined, avg_duration: undefined }, previous: undefined, series: [{ date: '2026-11-02', visitors: 3, pageviews: undefined }], top: undefined, search: undefined }])
  })
})

describe('traffic checks', () => {
  const base = (results: SourceResult[], fetched = '2026-11-04T06:00:00Z'): AnalyticsCache => ({ fetched, days: 30, ...ranges(30, new Date('2026-11-04T12:00:00Z')), results })
  const t = () => loadTopology(EXAMPLE).data!
  const today = new Date('2026-11-04T12:00:00')
  const traffic = (visitors: number, before: number, lastTwo = [5, 5]): SourceResult => ({ app: 'shop', provider: 'ga4', id: '1', ok: true, totals: { visitors }, previous: { visitors: before }, series: [{ date: '2026-11-02', visitors: lastTwo[0] }, { date: '2026-11-03', visitors: lastTwo[1] }] })
  const found = (cache: AnalyticsCache) => runChecks(t(), { today, analytics: cache }).filter((f) => ['traffic-drop', 'analytics-error', 'analytics-stale'].includes(f.check)).map((f) => `${f.id}@${f.level}/${f.severity}`)

  it('flags drops of half and four fifths, and silence', () => {
    expect(found(base([traffic(400, 1000)]))).toEqual(['traffic-drop:shop@50/warning'])
    expect(found(base([traffic(100, 1000)]))).toEqual(['traffic-drop:shop@80/critical'])
    expect(found(base([traffic(900, 1000, [0, 0])]))).toEqual(['traffic-drop:shop@silent/critical'])
    // Too little traffic before to judge.
    expect(found(base([traffic(1, 40)]))).toEqual([])
  })

  it('flags failed sources and old data', () => {
    expect(found(base([{ app: 'shop', provider: 'ga4', id: '1', ok: false, error: 'denied' }], '2026-10-20T06:00:00Z'))).toEqual(['analytics-error:shop/ga4@error/warning', 'analytics-stale:analytics@14/warning'])
  })
})

it('ships the analytics plugins with no install step', () => {
  for (const name of ['umami', 'posthog', 'google']) expect(inspect(resolve(`plugins/${name}`)).manifest.analytics?.providers.length).toBeGreaterThan(0)
})
