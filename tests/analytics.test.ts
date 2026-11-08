import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { analytics, cleanResults, readAnalytics, refreshAnalytics } from '../src/cli/analytics.ts'
import { loadTopology } from '../src/cli/load.ts'
import { scan, findTrackers, siteHosts } from '../src/cli/trackers.ts'
import { customRange, isRelative, mainResult, MAX_CUSTOM, normalizeAnalytics, panelUrl, pickPeriod, ranges, unlistedHosts, type AnalyticsCache, type AnalyticsRequest, type SourceResult } from '../src/core/analytics.ts'
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
    // A React Server Components payload, and data attributes.
    const rsc = scan(String.raw`2c:["$","$L59",null,{\"gaId\":\"G-RSCPAYLOAD1\"}]\n{\"api_host\":\"https://eu.i.posthog.com\",\"token\":\"phc_${'r'.repeat(43)}\"}`, 'https://x/')
    expect([...rsc.ga4]).toEqual(['G-RSCPAYLOAD1'])
    expect(rsc.posthog).toEqual([{ key: `phc_${'r'.repeat(43)}`, host: 'https://eu.i.posthog.com' }])
    const attrs = scan(`<body data-posthog-key="phc_${'d'.repeat(43)}" data-posthog-api-host="https://us.i.posthog.com" data-google-analytics-id="G-DATAATTR01">`, 'https://x/')
    expect([...attrs.ga4]).toEqual(['G-DATAATTR01'])
    expect(attrs.posthog[0].host).toBe('https://us.i.posthog.com')
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

  it('reads every site of an app, past a landing page with no tracker', async () => {
    const page = (body: string) => new Response(`<html>${body}</html>`)
    vi.stubGlobal('fetch', async (url: string) => {
      if (url === 'https://land.example/') return page('Sign up at web.land.example')
      if (url === 'https://web.land.example/') return page(`<script>posthog.init("phc_${'w'.repeat(43)}")</script>`)
      if (url === 'https://white.example/') return page(`<script>posthog.init("phc_${'x'.repeat(43)}")</script>`)
      return new Response('', { status: 404 })
    })
    const t = { apps: [{ id: 'app', name: 'App', domains: ['land.example', 'web.land.example', 'api.land.example', 'white.example'] }] } as unknown as Topology
    const [found] = await findTrackers(t)
    expect(found.posthog.map((p) => p.key[4])).toEqual(['w', 'x'])
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
      if (q.startsWith('SELECT count(DISTINCT person_id), count(), count(DISTINCT properties.$session_id)')) return json({ results: [[q.includes('2026-10-29') ? 9 : 21, 60, 25]] })
      if (q.includes('toDate(timestamp)')) return json({ results: [['2026-11-02', 7, 20]] })
      if (q.includes('properties.$host AS k')) return json({ results: [['admin.acme.example', 50], ['old-admin.acme.example', 30], ['localhost', 99], [null, 5]] })
      return json({ results: [['/orders', 33]] })
    })
    const r = (await runPlugin({ file, plugin: resolved('posthog', { hosts: ['https://eu.posthog.com'] }), run: { kind: 'analytics' }, input: req([{ app: 'admin', provider: 'posthog', id: 4242, hostnames: ['admin.acme.example', '*.shop.acme.example', "x'; DROP"] }]), asker: yes })) as { results: SourceResult[] }
    expect(r.results[0]).toMatchObject({ ok: true, totals: { visitors: 21, pageviews: 60, sessions: 25 }, previous: { visitors: 9 } })
    expect(r.results[0].series?.[1]).toEqual({ date: '2026-11-02', visitors: 7, pageviews: 20 })
    expect(queries[0]).toContain("properties.$host IN ('admin.acme.example')")
    expect(queries[0]).toContain("endsWith(properties.$host, '.shop.acme.example')")
    // Each list counts in its own unit: countries in people, referrers in visits.
    expect(queries.find((q) => q.includes('$geoip_country_code'))).toContain('count(DISTINCT person_id) AS v')
    expect(queries.find((q) => q.includes('$referring_domain'))).toContain('count(DISTINCT properties.$session_id) AS v')
    // Referrers leave out the app's own hostnames.
    expect(queries.find((q) => q.includes('$referring_domain'))).toContain("AND NOT ifNull((properties.$referring_domain IN ('admin.acme.example') OR endsWith(properties.$referring_domain, '.shop.acme.example')), 0)")
    expect(queries.join('\n')).not.toContain('DROP')
    // The hostname list is the whole project, unfiltered, and shows what no app lists.
    expect(queries.find((q) => q.includes('properties.$host AS k'))).not.toContain('properties.$host IN')
    expect(unlistedHosts(r.results, loadTopology(EXAMPLE).data!.apps!)).toEqual([{ app: 'admin', provider: 'posthog', id: '4242', host: 'old-admin.acme.example', pageviews: 30 }])
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

  it('says what a project collects when it has no pageviews', async () => {
    process.env.POSTHOG_PERSONAL_API_KEY = 'phx_key'
    const { file } = scratch()
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const q = JSON.parse(String(init.body)).query.query as string
      if (q.includes('SELECT event AS k')) return json({ results: [['$autocapture', 410], ['$screen', 12]] })
      if (q.startsWith('SELECT count(DISTINCT person_id), count(), count(DISTINCT properties.$session_id)')) return json({ results: [[0, 0, 0]] })
      return json({ results: [] })
    })
    const r = (await runPlugin({ file, plugin: resolved('posthog', { hosts: ['https://us.posthog.com'] }), run: { kind: 'analytics' }, input: req([{ app: 'admin', provider: 'posthog', id: 9, hostnames: ['admin.acme.example'] }]), asker: yes })) as { results: SourceResult[] }
    expect(r.results[0].ok).toBe(true)
    expect(r.results[0].note).toBe('no $pageview events in this period, only $autocapture (410), $screen (12): turn on capture_pageview in posthog-js, or this project measures something else')
  })

  it('says when the key cannot list organizations', async () => {
    process.env.POSTHOG_PERSONAL_API_KEY = 'phx_key'
    const { file } = scratch()
    vi.stubGlobal('fetch', async (url: string) => (new URL(url).pathname === '/api/projects/' ? json({ results: [{ id: 5, api_token: 'phc_current' }] }) : json({ detail: 'scope' }, 403)))
    const r = (await runPlugin({ file, plugin: resolved('posthog', { hosts: ['https://us.posthog.com'] }), run: { kind: 'link' }, input: { trackers: [{ app: 'admin', hostnames: [], umami: [], ga4: [], gtm: [], posthog: [{ key: 'phc_current' }] }] }, asker: yes })) as LinkResult
    expect(r.sources).toEqual([{ app: 'admin', source: { provider: 'posthog', id: 5 } }])
    expect(r.notes?.[0]).toMatch(/^key 1: .*403 for \/api\/organizations\/: only its current organization was searched/)
  })
})

describe('the posthog plugin with several accounts', () => {
  it('finds each project with the key that can see it, and reads it with that key', async () => {
    process.env.POSTHOG_PERSONAL_API_KEY = 'phx_shop, phx_admin'
    const { file } = scratch()
    const KEY = `phc_${'a'.repeat(43)}`
    const used: string[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const auth = new Headers(init.headers).get('authorization')
      const u = new URL(url)
      if (u.pathname.endsWith('/query/')) {
        used.push(auth!)
        return auth === 'Bearer phx_admin' ? json({ results: [[3, 9, 4]] }) : json({ detail: 'no access' }, 403)
      }
      if (u.pathname === '/api/projects/') return json({ results: auth === 'Bearer phx_admin' ? [{ id: 31, api_token: KEY }] : [{ id: 1, api_token: 'phc_shop' }] })
      return json({ results: [] })
    })
    const plugin = resolved('posthog', { hosts: ['https://us.posthog.com'] })
    const linked = (await runPlugin({ file, plugin, run: { kind: 'link' }, input: { trackers: [{ app: 'admin', hostnames: [], umami: [], ga4: [], gtm: [], posthog: [{ key: KEY }] }] }, asker: yes })) as LinkResult
    expect(linked.sources).toEqual([{ app: 'admin', source: { provider: 'posthog', id: 31 } }])
    const r = (await runPlugin({ file, plugin, run: { kind: 'analytics' }, input: req([{ app: 'admin', provider: 'posthog', id: 31, hostnames: ['admin.acme.example'] }]), asker: yes })) as { results: SourceResult[] }
    expect(r.results[0]).toMatchObject({ ok: true, totals: { visitors: 3 } })
    // The shop key is tried once; every later query goes straight to the admin key.
    expect(used.filter((a) => a === 'Bearer phx_shop')).toHaveLength(1)
    expect(used.length).toBeGreaterThan(5)
  })

  it('names the keys it tried, never the keys themselves', async () => {
    process.env.POSTHOG_PERSONAL_API_KEY = 'phx_secret_one # events\nphx_secret_two'
    const { file } = scratch()
    vi.stubGlobal('fetch', async () => json({ detail: 'no' }, 403))
    const r = (await runPlugin({ file, plugin: resolved('posthog', { hosts: ['https://us.posthog.com'] }), run: { kind: 'analytics' }, input: req([{ app: 'admin', provider: 'posthog', id: 31, hostnames: [] }]), asker: yes })) as { results: SourceResult[] }
    expect(r.results[0].error).toBe('no key can read project 31 on https://us.posthog.com (events 403, key 2 403)')
    expect(JSON.stringify(r)).not.toContain('phx_secret')
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
      // The second batch: the previous period's days, devices, browsers, operating systems.
      if (url.endsWith(':batchRunReports') && JSON.parse(String(init.body)).requests[1]?.dimensions?.[0]?.name === 'deviceCategory')
        return json({
          reports: [
            { rows: [{ dimensionValues: [{ value: '20261030' }], metricValues: [{ value: '90' }, { value: '200' }] }] },
            { rows: [{ dimensionValues: [{ value: 'mobile' }], metricValues: [{ value: '200' }] }] },
            { rows: [{ dimensionValues: [{ value: 'Chrome' }], metricValues: [{ value: '150' }] }] },
            { rows: [{ dimensionValues: [{ value: 'Android' }], metricValues: [{ value: '120' }] }] },
          ],
        })
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
    expect(r.results[0]).toMatchObject({ ok: true, totals: { visitors: 300, pageviews: 900, sessions: 400, bounce_rate: 0.4 }, previous: { visitors: 200 }, top: { pages: [{ key: '/', value: 500 }], devices: [{ key: 'mobile', value: 200 }], browsers: [{ key: 'Chrome', value: 150 }], os: [{ key: 'Android', value: 120 }] } })
    // The previous period, day by day, every day filled.
    expect(r.results[0].previousSeries?.length).toBe(3)
    expect(r.results[0].previousSeries?.find((p) => p.date === '2026-10-30')).toEqual({ date: '2026-10-30', visitors: 90, pageviews: 200 })
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

  it('refresh fetches the last 7, 30 and 90 days, says which sources have no plugin, and notes each server', async () => {
    const file = await project()
    umamiServer()
    const out = await refreshAnalytics(file, { timezone: 'UTC', asker: yes, log: () => undefined })
    expect(out.periods.map((p) => p.key)).toEqual(['7d', '30d', '90d'])
    expect(readAnalytics(file)).toEqual(out)
    const month = pickPeriod(out)!
    expect(month.key).toBe('30d')
    // The server comes from options.hosts, for the link to its dashboard.
    expect(month.results.find((r) => r.provider === 'umami')).toMatchObject({ app: 'status', ok: true, totals: { visitors: 40 }, host: 'https://u.acme.example' })
    expect(month.results.find((r) => r.provider === 'ga4')).toMatchObject({ ok: false, error: expect.stringContaining('malha plugin add google') })
    expect(month.results.find((r) => r.provider === 'posthog')).toMatchObject({ ok: false, error: expect.stringContaining('malha plugin add posthog') })
  })

  it('refresh adds a fixed range beside the others, and keeps the latest few', async () => {
    const file = await project()
    umamiServer()
    const opts = { timezone: 'UTC', asker: yes, log: () => undefined, today: new Date('2026-11-04T12:00:00') }
    await refreshAnalytics(file, { ...opts, periods: [30] })
    const out = await refreshAnalytics(file, { ...opts, periods: [{ from: '2026-09-01', to: '2026-09-30' }] })
    expect(out.periods.map((p) => p.key)).toEqual(['30d', '2026-09-01..2026-09-30'])
    expect(out.periods[1]).toMatchObject({ days: 30, range: { from: '2026-09-01', to: '2026-09-30' }, previous: { from: '2026-08-02', to: '2026-08-31' } })
    for (let m = 1; m <= MAX_CUSTOM; m++) await refreshAnalytics(file, { ...opts, periods: [{ from: `2025-0${m}-01`, to: `2025-0${m}-10` }] })
    const keys = readAnalytics(file)!.periods.map((p) => p.key)
    expect(keys.filter((k) => !isRelative(k))).toHaveLength(MAX_CUSTOM)
    expect(keys).toContain('30d')
    expect(keys).not.toContain('2026-09-01..2026-09-30')
    await expect(refreshAnalytics(file, { ...opts, periods: [{ from: '2026-11-03', to: '2026-11-04' }] })).rejects.toThrow(/end by yesterday/)
  })

  it('keeps only what was asked for, in bounds', () => {
    const request = req([{ app: 'shop', provider: 'ga4', id: '1', hostnames: [] }])
    const out = cleanResults({ results: [{ app: 'shop', provider: 'ga4', id: '1', ok: true, totals: { visitors: -5, pageviews: 1e3, bounce_rate: 7 }, series: [{ date: 'nope' }, { date: '2026-11-02', visitors: 3 }] }, { app: 'other', provider: 'ga4', id: '9', ok: true }] }, request)
    expect(out).toEqual([{ app: 'shop', provider: 'ga4', id: '1', host: undefined, primary: undefined, ok: true, error: undefined, totals: { visitors: undefined, pageviews: 1000, sessions: undefined, bounce_rate: undefined, avg_duration: undefined }, previous: undefined, series: [{ date: '2026-11-02', visitors: 3, pageviews: undefined }], top: undefined, search: undefined }])
  })
})

describe('traffic checks', () => {
  const base = (results: SourceResult[], fetched = '2026-11-04T06:00:00Z'): AnalyticsCache => ({ key: '30d', fetched, days: 30, ...ranges(30, new Date('2026-11-04T12:00:00Z')), results })
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

describe('apps with several sites', () => {
  it('loads one page per site an app serves, bare domain or www first', async () => {
    expect(siteHosts(['brand.example', 'www.brand.example', 'api.brand.example', 'brand-vip.example', '*.partner.example', 'partner.example', 'app.acme.com.br', 'www.acme.com.br'])).toEqual([
      ['brand.example', 'www.brand.example', 'api.brand.example'],
      ['brand-vip.example'],
      ['partner.example'],
      ['www.acme.com.br', 'app.acme.com.br'],
    ])
  })

  it('adds up an app’s sources from its main provider, and leaves the others out', () => {
    const ph = (id: string, visitors: number, before: number, series: number[]): SourceResult => ({
      app: 'shop', provider: 'posthog', id, ok: true,
      totals: { visitors, pageviews: visitors * 2, sessions: visitors, bounce_rate: id === 'a' ? 0.2 : 0.6 },
      previous: { visitors: before },
      series: series.map((v, i) => ({ date: `2026-11-0${i + 1}`, visitors: v })),
      previousSeries: series.map((v, i) => ({ date: `2026-10-0${i + 1}`, visitors: v * 2 })),
      top: { pages: [{ key: '/', value: visitors }], browsers: [{ key: 'Firefox', value: 1 }] },
    })
    const main = mainResult([
      ph('a', 300, 200, [1, 2]),
      { app: 'shop', provider: 'ga4', id: 'g', ok: true, totals: { visitors: 999 } },
      ph('b', 100, 100, [10, 20]),
      { app: 'shop', provider: 'posthog', id: 'c', ok: false, error: 'denied' },
    ])!
    expect(main).toMatchObject({ provider: 'posthog', id: 'a + b', totals: { visitors: 400, pageviews: 800, sessions: 400 }, previous: { visitors: 300 } })
    expect(main.totals!.bounce_rate).toBeCloseTo(0.3)
    expect(main.series).toEqual([{ date: '2026-11-01', visitors: 11 }, { date: '2026-11-02', visitors: 22 }])
    expect(main.top?.pages).toEqual([{ key: '/', value: 400 }])
    expect(main.top?.browsers).toEqual([{ key: 'Firefox', value: 2 }])
    expect(main.previousSeries).toEqual([{ date: '2026-10-01', visitors: 22 }, { date: '2026-10-02', visitors: 44 }])
    expect(main.parts?.map((p) => p.id)).toEqual(['a', 'b'])
    // One source: returned as is.
    expect(mainResult([ph('a', 1, 1, [])])?.parts).toBeUndefined()
  })
})

describe('periods', () => {
  const r30 = ranges(30, new Date('2026-11-04T12:00:00'))
  it('reads a file from 0.6, with one period at the top', () => {
    const old = { fetched: '2026-11-04T06:00:00Z', days: 30, ...r30, results: [] }
    expect(normalizeAnalytics(old)).toEqual({ version: 2, periods: [{ ...old, key: '30d' }] })
    expect(normalizeAnalytics(null)).toBeNull()
    expect(normalizeAnalytics({ nothing: true })).toBeNull()
  })

  it('picks the asked period, else the last 30 days, else the first relative one', () => {
    const p = (key: string, days: number): AnalyticsCache => ({ key, days, fetched: '', ...r30, results: [] })
    const file = { version: 2 as const, periods: [p('7d', 7), p('30d', 30), p('2026-09-01..2026-09-30', 30)] }
    expect(pickPeriod(file, '7d')?.key).toBe('7d')
    expect(pickPeriod(file, '14d')?.key).toBe('30d')
    expect(pickPeriod({ version: 2, periods: [p('2026-09-01..2026-09-30', 30), p('7d', 7)] })?.key).toBe('7d')
    expect(pickPeriod(null)).toBeUndefined()
  })

  it('checks a custom range, and finds the one before it', () => {
    const today = new Date('2026-11-08T12:00:00')
    expect(customRange('2026-10-01', '2026-10-31', today)).toEqual({ range: { from: '2026-10-01', to: '2026-10-31' }, previous: { from: '2026-08-31', to: '2026-09-30' }, days: 31 })
    expect(customRange('2026-11-01', '2026-11-08', today)).toEqual({ error: 'the range must end by yesterday (2026-11-07): today is not over yet' })
    expect(customRange('2026-02-30', '2026-03-01', today)).toEqual({ error: 'dates are YYYY-MM-DD' })
    expect(customRange('2026-10-02', '2026-10-01', today)).toEqual({ error: 'the range starts after it ends' })
    expect(customRange('2024-01-01', '2025-06-01', today)).toEqual({ error: 'a range is at most 366 days' })
  })
})

describe('dashboard links', () => {
  const range = { from: '2026-10-01', to: '2026-10-31' }
  it('builds each provider’s link from the id alone, with the dates where it reads them', () => {
    expect(panelUrl({ provider: 'ga4', id: '312345678' }, range)).toBe('https://analytics.google.com/analytics/web/#/p312345678/reports/intelligenthome')
    expect(panelUrl({ provider: 'search-console', id: 'sc-domain:acme.example' }, range)).toBe('https://search.google.com/search-console/performance/search-analytics?resource_id=sc-domain%3Aacme.example&start_date=20261001&end_date=20261031')
    expect(panelUrl({ provider: 'posthog', id: 4242, host: 'https://eu.posthog.com' }, range)).toBe('https://eu.posthog.com/project/4242/web?date_from=2026-10-01&date_to=2026-10-31')
    expect(panelUrl({ provider: 'posthog', id: '4242' })).toBe('https://us.posthog.com/project/4242/web')
    expect(panelUrl({ provider: 'umami', id: UUID, host: 'https://umami.acme.example' })).toBe(`https://umami.acme.example/websites/${UUID}`)
    expect(panelUrl({ provider: 'umami', id: UUID, host: 'https://api.umami.is' })).toBe(`https://cloud.umami.is/websites/${UUID}`)
  })

  it('makes no link from an id or a server that would lead somewhere else', () => {
    expect(panelUrl({ provider: 'ga4', id: '1/../../x' })).toBeUndefined()
    expect(panelUrl({ provider: 'posthog', id: '1?next=https://evil.example' })).toBeUndefined()
    expect(panelUrl({ provider: 'search-console', id: 'javascript:alert(1)' })).toBeUndefined()
    expect(panelUrl({ provider: 'umami', id: UUID, host: 'javascript:alert(1)' })).toBeUndefined()
    expect(panelUrl({ provider: 'umami', id: 'not-a-website-id', host: 'https://umami.acme.example' })).toBeUndefined()
    // A server with a path is not a server: the default one is used.
    expect(panelUrl({ provider: 'posthog', id: 7, host: 'https://evil.example/phish' })).toBe('https://us.posthog.com/project/7/web')
  })
})

describe('the dev server fetches a range only for its own page', () => {
  it('refuses other callers, bad bodies, and a server without plugins', async () => {
    const { createServer } = await import('node:http')
    const { createApi } = await import('../src/cli/api.ts')
    const { file } = scratch()
    const api = createApi(file, { plugins: false, loopback: true, log: () => undefined })
    const server = createServer((rq, rs) => api.handle(rq, rs) || rs.writeHead(404).end())
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as import('node:net').AddressInfo).port
    const token = /content="([^"]+)"/.exec(api.injectToken('<head></head>'))![1]
    const good = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'x-malha-token': token, 'content-type': 'application/json' }
    const post = async (headers: Record<string, string>, body: unknown) =>
      (await fetch(`http://127.0.0.1:${port}/api/analytics/range`, { method: 'POST', headers, body: JSON.stringify(body) })).status
    try {
      expect(await post({ ...good, 'x-malha-token': 'nope' }, { from: '2026-09-01', to: '2026-09-30' })).toBe(403)
      expect(await post({ ...good, origin: 'http://evil.test' }, { from: '2026-09-01', to: '2026-09-30' })).toBe(403)
      expect(await post(good, { from: 20260901 })).toBe(400)
      expect(await post(good, { from: '2026-09-01', to: '2026-09-30' })).toBe(409)
    } finally {
      api.close()
      server.close()
    }
  })
})
