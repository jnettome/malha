import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Manifest } from './sdk.ts'
import { hashPlugin, MANIFEST, readManifest, shortHash } from './manifest.ts'
import { expandPatterns } from './rules.ts'

// malha.plugins.json, next to the topology file and committed with it: which plugins this project
// uses, where they come from, and (for plugins that are not part of Malha) the hash of the code
// that was reviewed. Each person still approves what a plugin does on their own machine.

export const PROJECT_FILE = 'malha.plugins.json'
export const BUILTIN_DIR = fileURLToPath(new URL('../../plugins/', import.meta.url))

export interface Entry {
  /** `builtin:<name>`, or a folder relative to this file. */
  source: string
  /** sha256 of the folder when it was added; a mismatch stops the plugin from running. */
  integrity?: string
  /** Passed to the plugin as ctx.options. */
  options?: Record<string, unknown>
  /** false keeps a plugin's live data out of `malha dev`. */
  live?: boolean
  /** false keeps a notifier plugin out of `malha check --notify`. */
  notify?: boolean
}

export interface ProjectFile {
  plugins: Record<string, Entry>
}

export interface Resolved {
  name: string
  dir: string
  builtin: boolean
  manifest: Manifest
  integrity: string
  files: number
  entry: Entry
  /** Permissions that could not be filled from the options. */
  warnings: string[]
}

export const projectPath = (file: string) => join(dirname(file), PROJECT_FILE)

export function readProject(file: string): ProjectFile {
  const path = projectPath(file)
  if (!existsSync(path)) return { plugins: {} }
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as Partial<ProjectFile>
    return { plugins: data.plugins ?? {} }
  } catch (e) {
    throw new Error(`${PROJECT_FILE} is not valid JSON: ${(e as Error).message}`)
  }
}

export function writeProject(file: string, project: ProjectFile) {
  const sorted = Object.fromEntries(Object.entries(project.plugins).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(projectPath(file), `${JSON.stringify({ plugins: sorted }, null, 2)}\n`)
}

export const builtinNames = () =>
  existsSync(BUILTIN_DIR) ? readdirSync(BUILTIN_DIR).filter((n) => existsSync(join(BUILTIN_DIR, n, MANIFEST))).sort() : []

/** A folder rather than the name of a plugin that ships with Malha. */
export const isPath = (source: string) => !source.startsWith('builtin:') && /[\\/.]/.test(source)

/** Where a source points: a plugin shipped with Malha, or a folder (relative to `base`). */
export function locate(source: string, base: string) {
  const name = isPath(source) ? undefined : source.replace(/^builtin:/, '')
  if (name !== undefined) {
    if (!builtinNames().includes(name)) throw new Error(`no plugin called "${name}" ships with Malha (there are: ${builtinNames().join(', ') || 'none'})`)
    return { dir: join(BUILTIN_DIR, name), builtin: true, source: `builtin:${name}` }
  }
  const dir = isAbsolute(source) ? source : resolve(base, source)
  if (!existsSync(join(dir, MANIFEST))) throw new Error(`${source} is not a plugin folder (no ${MANIFEST})`)
  const rel = relative(base, dir).split(sep).join('/')
  // Relative, so it works on every checkout of the project. A folder far outside it stays absolute:
  // a long ../../.. path would not work elsewhere either.
  const far = isAbsolute(rel) || rel.split('/').filter((s) => s === '..').length > 2
  return { dir, builtin: false, source: far ? dir : rel.startsWith('..') ? rel : `./${rel}`, outside: far }
}

/** Read and hash a plugin folder. */
export function inspect(dir: string) {
  const manifest = readManifest(dir)
  return { manifest, ...hashPlugin(dir) }
}

/** A plugin listed in malha.plugins.json, checked against the hash that was reviewed. */
export function loadPlugin(file: string, name: string): Resolved {
  const entry = readProject(file).plugins[name]
  if (!entry) throw new Error(`"${name}" is not in ${PROJECT_FILE}. Add it with: malha plugin add <source>`)
  const { dir, builtin } = locate(entry.source, dirname(file))
  const { manifest, integrity, files } = inspect(dir)
  if (manifest.name !== name) throw new Error(`${entry.source} is the plugin "${manifest.name}", but ${PROJECT_FILE} lists it as "${name}"`)
  if (!builtin && entry.integrity !== integrity)
    throw new Error(
      `${name} changed since it was added (${entry.integrity ? shortHash(entry.integrity) : 'no hash'} → ${shortHash(integrity)}). ` +
        `Review the code, then run: malha plugin add ${entry.source}`,
    )
  const { patterns, problems } = expandPatterns(manifest.permissions.fetch, entry.options)
  const expanded = { ...manifest, permissions: { ...manifest.permissions, fetch: patterns } }
  return { name, dir, builtin, manifest: expanded, integrity, files, entry, warnings: problems }
}

/** Every listed plugin; one that fails to load comes back as an error instead. */
export function loadPlugins(file: string) {
  return Object.keys(readProject(file).plugins).map((name) => {
    try {
      return { name, plugin: loadPlugin(file, name) }
    } catch (e) {
      return { name, error: (e as Error).message }
    }
  })
}
