import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, normalize } from 'node:path'
import { createApi, isLoopbackHost } from './api.ts'
import { loadTopology, type Loaded } from './load.ts'
import { display, viewerDir } from './paths.ts'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
}

export function report(file: string, { errors, warnings }: Loaded) {
  const name = display(file)
  const time = new Date().toTimeString().slice(0, 8)
  for (const w of warnings) console.warn(`${time} warn  ${w}`)
  for (const e of errors) console.error(`${time} error ${e}`)
  console.log(`${time} ${name}: ${errors.length ? `${errors.length} error(s), the page shows them` : 'ok'}${warnings.length ? `, ${warnings.length} warning(s)` : ''}`)
}

const stamp = () => new Date().toTimeString().slice(0, 8)

/** Serve the viewer for one topology file, reloading the page whenever the file changes. */
export async function dev(file: string, opts: { port: number; host: string; plugins: boolean }) {
  const root = viewerDir()
  report(file, loadTopology(file))
  const loopback = isLoopbackHost(opts.host)
  const api = createApi(file, { onReload: (r) => report(file, r), plugins: opts.plugins, loopback, log: (line) => console.log(`${stamp()} ${line}`) })

  const server = createServer((req, res) => {
    if (api.handle(req, res)) return
    const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase()
    if (loopback && !isLoopbackHost(host)) {
      res.writeHead(403).end('wrong host')
      return
    }
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
    const target = normalize(join(root, path === '/' ? 'index.html' : path))
    if (!target.startsWith(root) || !existsSync(target) || !statSync(target).isFile()) {
      res.writeHead(404).end('not found')
      return
    }
    const headers = { 'content-type': TYPES[extname(target)] ?? 'application/octet-stream' }
    if (target.endsWith('index.html')) {
      res.writeHead(200, { ...headers, 'cache-control': 'no-store' }).end(api.injectToken(readFileSync(target, 'utf8')))
      return
    }
    res.writeHead(200, headers)
    createReadStream(target).pipe(res)
  })

  const port = await listen(server, opts.port, opts.host)
  console.log(`\nMalha is showing ${display(file)} at http://${opts.host === '0.0.0.0' ? 'localhost' : opts.host}:${port}`)
  console.log('Edit and save the file; the page reloads. Ctrl+C stops.\n')
  const stop = () => {
    api.close()
    server.close()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

/** Listen on the port, or the next free one. Resolves with the port actually bound. */
export function listen(server: Server, port: number, host: string, tries = 10): Promise<number> {
  return new Promise((resolve, reject) => {
    // One listener for the whole search: a callback passed to each listen() call would stay
    // registered after that attempt failed, and fire with the wrong port when a later one works.
    server.once('listening', () => resolve((server.address() as AddressInfo).port))
    const attempt = (p: number, left: number) => {
      server.once('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE' && left > 0) attempt(p + 1, left - 1)
        else reject(e)
      })
      server.listen(p, host)
    }
    attempt(port, tries)
  })
}
