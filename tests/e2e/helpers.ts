import { spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { Page } from '@playwright/test'

export const CLI = 'dist/cli/index.js'
export const EXAMPLE = 'examples/acme/topology.yaml'

/** A scratch copy of the example, so a test can edit it. */
export function copyExample() {
  const dir = mkdtempSync(join(tmpdir(), 'malha-e2e-'))
  const file = join(dir, 'topology.yaml')
  copyFileSync(EXAMPLE, file)
  return { dir, file }
}

/** Start `malha dev` on a file and resolve once it is listening. */
export function devServer(file: string, port: number): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'dev', file, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => reject(new Error('malha dev did not start')), 10_000)
    child.stdout!.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('Malha is showing')) {
        clearTimeout(timer)
        resolve(child)
      }
    })
    child.on('exit', (code) => reject(new Error(`malha dev exited with ${code}`)))
  })
}

/** A minimal static file server, for a `malha build` output. */
export function staticServer(root: string, port: number): Promise<Server> {
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    const path = pathname === '/' ? '/index.html' : pathname
    try {
      const body = await readFile(join(root, path))
      res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' }).end(body)
    } catch {
      res.writeHead(404).end()
    }
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

/** Console errors and warnings, plus uncaught exceptions, for the life of the page. */
export function collectErrors(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push(`${m.type()}: ${m.text()}`))
  return errors
}

/** Elements reaching past the right edge, ignoring sideways scrollers and ellipsis-clipped text. */
export function overflowing(page: Page) {
  return page.evaluate(() => {
    const vw = window.innerWidth
    const bad = new Set<string>()
    for (const el of document.querySelectorAll('.stage__view *')) {
      if (el.closest('.table-wrap, .tabs, svg, .unscanned code')) continue
      if (el.parentElement && getComputedStyle(el.parentElement).overflow === 'hidden') continue
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.right > vw + 1) bad.add(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`)
    }
    return [...bad]
  })
}
