import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, dirname } from 'node:path'
import { createLive, type Live } from '../plugins/live.ts'
import { loadTopology, type Loaded } from './load.ts'
import { analyticsPath } from './analytics.ts'
import { display, scanPath } from './paths.ts'

export interface Api {
  /** Answers api/* requests; returns false for anything else. */
  handle(req: IncomingMessage, res: ServerResponse): boolean
  /** index.html with this server's token in it, for answering plugin questions. */
  injectToken(html: string): string
  close(): void
}

export interface ApiOptions {
  onReload?: (result: Loaded) => void
  /** Run live plugins. */
  plugins?: boolean
  /** The server listens on loopback only: refuse other Host headers, and allow answers from the page. */
  loopback?: boolean
  log?: (line: string) => void
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
const hostname = (host: string | undefined) => (host ?? '').replace(/:\d+$/, '').toLowerCase()
export const isLoopbackHost = (host: string) => LOOPBACK.has(host)

/**
 * The data side of `malha dev`: the topology as JSON, the scan, live plugin data, and a server-sent
 * event stream (`change` when a file changes on disk, `live` when live data or questions change).
 * Also mounted into Vite when developing Malha itself.
 */
export function createApi(file: string, opts: ApiOptions = {}): Api {
  const scan = scanPath(file)
  const clients = new Set<ServerResponse>()
  const token = randomBytes(24).toString('base64url')
  let timer: NodeJS.Timeout | undefined

  const broadcast = (event: string, data: unknown) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const c of clients) c.write(payload)
  }
  const live: Live | undefined = opts.plugins
    ? createLive(file, { broadcast, log: opts.log ?? ((l) => console.log(l)), browserApprovals: opts.loopback ?? false })
    : undefined

  const notify = () => {
    clearTimeout(timer)
    // Editors write files in several steps; wait for the last one.
    timer = setTimeout(() => {
      opts.onReload?.(loadTopology(file))
      broadcast('change', {})
    }, 120)
  }
  // Watch directories, not files: many editors save by replacing the file.
  const watchers: FSWatcher[] = []
  const watchFor = (target: string) => {
    const dir = dirname(target)
    if (!existsSync(dir)) return
    watchers.push(watch(dir, (_event, name) => name && basename(String(name)) === basename(target) && notify()))
  }
  watchFor(file)
  watchFor(scan)
  watchFor(analyticsPath(file))
  // .malha/ may not exist until the first scan; watch its parent for its creation too.
  // Plugins also create it (for approvals and their log); only a scan matters here.
  if (!existsSync(dirname(scan))) watchers.push(watch(dirname(file), (_e, name) => name === '.malha' && (existsSync(scan) || existsSync(analyticsPath(file))) && notify()))

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(typeof body === 'string' ? body : JSON.stringify(body))
  }

  /** Only a page this server served, opened through a local address, may answer. */
  function answerAllowed(req: IncomingMessage) {
    if (!opts.loopback) return 'this server is reachable from other machines; approve in a terminal with malha plugin allow'
    const host = req.headers.host ?? ''
    if (!LOOPBACK.has(hostname(host))) return 'wrong host'
    if (req.headers.origin !== `http://${host}`) return 'wrong origin'
    const given = Buffer.from(String(req.headers['x-malha-token'] ?? ''))
    const expected = Buffer.from(token)
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 'wrong token'
  }

  /** A small JSON body from a page this server served (see answerAllowed). */
  function readBody(req: IncomingMessage, res: ServerResponse, then: (body: Record<string, unknown>) => void) {
    const refused = answerAllowed(req)
    if (refused) return json(res, 403, { error: refused })
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      body += chunk
      if (body.length > 4096) req.destroy()
    })
    req.on('end', () => {
      let parsed: unknown
      try {
        parsed = JSON.parse(body)
      } catch {
        return json(res, 400, { error: 'not JSON' })
      }
      if (!parsed || typeof parsed !== 'object') return json(res, 400, { error: 'not a JSON object' })
      then(parsed as Record<string, unknown>)
    })
  }

  function answer(req: IncomingMessage, res: ServerResponse) {
    readBody(req, res, ({ id, answer: a }) => {
      if (typeof id !== 'string' || (a !== 'once' && a !== 'always' && a !== 'deny')) return json(res, 400, { error: 'want { id, answer: once | always | deny }' })
      json(res, live?.answer(id, a) ? 200 : 404, { ok: true })
    })
  }

  /** Fetch a date range of traffic for the page's picker; answers when it is written. */
  function fetchRange(req: IncomingMessage, res: ServerResponse) {
    readBody(req, res, ({ from, to }) => {
      if (typeof from !== 'string' || typeof to !== 'string') return json(res, 400, { error: 'want { from, to } as YYYY-MM-DD' })
      if (!live) return json(res, 409, { error: 'plugins are off: start malha dev without --no-plugins to fetch traffic' })
      void live.fetchRange(from, to).then(({ status, ...body }) => json(res, status, body))
    })
  }

  return {
    handle(req, res) {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname.replace(/^.*\/api\//, 'api/')
      if (!path.startsWith('api/')) return false
      // A loopback server answers only to local names, which stops DNS rebinding.
      if (opts.loopback && !LOOPBACK.has(hostname(req.headers.host))) {
        json(res, 403, { error: 'wrong host' })
        return true
      }
      if (path === 'api/topology.json') {
        const { data, errors } = loadTopology(file)
        if (data && !errors.length) json(res, 200, data)
        else json(res, 422, { file: display(file), errors })
        return true
      }
      if (path === 'api/scan.json') {
        // No scan yet is a normal state, not an error: answer null.
        json(res, 200, existsSync(scan) ? readFileSync(scan, 'utf8') : 'null')
        return true
      }
      if (path === 'api/analytics.json') {
        const traffic = analyticsPath(file)
        json(res, 200, existsSync(traffic) ? readFileSync(traffic, 'utf8') : 'null')
        return true
      }
      if (path === 'api/live.json') {
        json(res, 200, live ? live.snapshot() : 'null')
        return true
      }
      if (path === 'api/answer' && req.method === 'POST') {
        answer(req, res)
        return true
      }
      if (path === 'api/analytics/range' && req.method === 'POST') {
        fetchRange(req, res)
        return true
      }
      if (path === 'api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
        res.write(': connected\n\n')
        clients.add(res)
        req.on('close', () => clients.delete(res))
        return true
      }
      json(res, 404, { error: 'no such endpoint' })
      return true
    },
    // Without plugins there is nothing to answer or fetch, so the page gets no token to ask with.
    injectToken: (html) => (live ? html.replace('</head>', `<meta name="malha-token" content="${token}">\n</head>`) : html),
    close() {
      clearTimeout(timer)
      live?.close()
      for (const w of watchers) w.close()
      for (const c of clients) c.end()
    },
  }
}
