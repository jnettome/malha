import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadTopology } from './load.ts'
import { analyticsPath } from './analytics.ts'
import { display, scanPath, viewerDir } from './paths.ts'

/** JSON inside a <script> tag: escape `<` so no string can close the tag early. */
export const scriptJson = (id: string, json: string) => `<script type="application/json" id="${id}">${json.replace(/</g, '\\u003c')}</script>`

/**
 * A static copy of the viewer with the data inside index.html, for any static host (an internal
 * web server, an S3 bucket behind auth, `npx serve`). Browsers won't run its module scripts from
 * file://, so it needs serving. Fails on an invalid topology.
 */
export function build(file: string, outDir: string, opts: { scan: boolean; analytics: boolean }) {
  const { data, errors, warnings } = loadTopology(file)
  for (const w of warnings) console.warn(`warn  ${w}`)
  if (!data || errors.length) {
    for (const e of errors) console.error(`error ${e}`)
    throw new Error(`${display(file)} is invalid; nothing was built`)
  }
  if (existsSync(outDir)) rmSync(outDir, { recursive: true })
  cpSync(viewerDir(), outDir, { recursive: true })

  const tags = [scriptJson('malha-topology', JSON.stringify(data))]
  const scan = scanPath(file)
  if (opts.scan && existsSync(scan)) tags.push(scriptJson('malha-scan', readFileSync(scan, 'utf8').trim()))
  const traffic = analyticsPath(file)
  if (opts.analytics && existsSync(traffic)) tags.push(scriptJson('malha-analytics', readFileSync(traffic, 'utf8').trim()))
  const index = join(outDir, 'index.html')
  writeFileSync(index, readFileSync(index, 'utf8').replace('</head>', `${tags.join('\n')}\n</head>`))
  const extras = [tags.some((t) => t.includes('malha-scan')) && 'the dependency scan', tags.some((t) => t.includes('malha-analytics')) && 'traffic'].filter(Boolean)
  console.log(`Built ${display(outDir)}/ with ${data.nodes.length} nodes${extras.length ? ` and ${extras.join(' and ')}` : ''}. Serve the folder with any static web server.`)
}
