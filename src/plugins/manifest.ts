import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Ajv } from 'ajv'
import type { Manifest } from './sdk.ts'
import { checkPatterns } from './rules.ts'

export const MANIFEST = 'malha-plugin.json'
const SCHEMA = fileURLToPath(new URL('../../schema/plugin.schema.json', import.meta.url))

/** Names that are Malha's own commands, so a plugin cannot take them over. */
export const RESERVED = new Set(['init', 'dev', 'validate', 'build', 'scan', 'check', 'domains', 'schema', 'plugin', 'plugins', 'help', 'version'])

const LIMITS = { files: 2000, bytes: 50 * 1024 * 1024 }

let validator: ReturnType<Ajv['compile']> | undefined

export function readManifest(dir: string): Manifest {
  const file = join(dir, MANIFEST)
  if (!existsSync(file)) throw new Error(`${dir} has no ${MANIFEST}`)
  let data: unknown
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    throw new Error(`${MANIFEST} is not valid JSON: ${(e as Error).message}`)
  }
  validator ??= new Ajv({ allErrors: true }).compile(JSON.parse(readFileSync(SCHEMA, 'utf8')))
  if (!validator(data)) {
    const problems = (validator.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message}`)
    throw new Error(`${MANIFEST} is invalid:\n  ${problems.join('\n  ')}`)
  }
  const manifest = data as Manifest
  if (RESERVED.has(manifest.name)) throw new Error(`plugin name "${manifest.name}" is one of Malha's own commands`)
  const problems = checkPatterns(manifest.permissions)
  if (problems.length) throw new Error(`${MANIFEST} has bad permissions:\n  ${problems.join('\n  ')}`)
  if (!existsSync(join(dir, manifest.main))) throw new Error(`${MANIFEST} names main "${manifest.main}", which does not exist`)
  return manifest
}

/**
 * sha256 over every file's path and content. Refuses symlinks: Node's permission model follows them,
 * so a link inside the folder could expose files outside it. `.git` is skipped.
 */
export function hashPlugin(dir: string) {
  const hash = createHash('sha256')
  let files = 0
  let bytes = 0
  const walk = (at: string) => {
    for (const name of readdirSync(at).sort()) {
      if (name === '.git') continue
      const full = join(at, name)
      const st = lstatSync(full)
      const rel = relative(dir, full).split(sep).join('/')
      if (st.isSymbolicLink()) throw new Error(`plugin folder contains a symlink (${rel}); plugins must be plain files`)
      if (st.isDirectory()) walk(full)
      else if (st.isFile()) {
        if (++files > LIMITS.files) throw new Error(`plugin folder has more than ${LIMITS.files} files`)
        bytes += st.size
        if (bytes > LIMITS.bytes) throw new Error(`plugin folder is larger than ${LIMITS.bytes / 1024 / 1024} MB`)
        hash.update(`${rel}\0${st.size}\0`)
        hash.update(readFileSync(full))
      }
    }
  }
  walk(dir)
  return { integrity: `sha256-${hash.digest('base64')}`, files, bytes }
}

/** The first 12 characters of the digest, for messages. */
export const shortHash = (integrity: string) => integrity.replace(/^sha256-/, '').slice(0, 12)
