import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from '../cli/paths.ts'

// Per-person state in .malha/ (never committed): "don't ask again" answers, and a log of every call
// a plugin made. Answers are tied to the plugin's code hash, so new code asks again.

interface Grants {
  [plugin: string]: { integrity: string; rules: Record<string, string> }
}

const grantsPath = (file: string) => join(stateDir(file), 'grants.json')
const logPath = (file: string) => join(stateDir(file), 'plugins.log')

function ensureDir(file: string) {
  const dir = stateDir(file)
  mkdirSync(dir, { recursive: true })
  // Ignored even where nobody added .malha/ to .gitignore.
  if (!existsSync(join(dir, '.gitignore'))) writeFileSync(join(dir, '.gitignore'), '*\n')
}

function readGrants(file: string): Grants {
  try {
    return JSON.parse(readFileSync(grantsPath(file), 'utf8')) as Grants
  } catch {
    return {}
  }
}

const writeGrants = (file: string, grants: Grants) => {
  ensureDir(file)
  writeFileSync(grantsPath(file), `${JSON.stringify(grants, null, 2)}\n`)
}

/** Rules this person allowed for this exact plugin code. */
export function allowedRules(file: string, plugin: string, integrity: string) {
  const g = readGrants(file)[plugin]
  return g && g.integrity === integrity ? g.rules : {}
}

export function allowAlways(file: string, plugin: string, integrity: string, keys: string[]) {
  const grants = readGrants(file)
  const current = grants[plugin]?.integrity === integrity ? grants[plugin].rules : {}
  const today = new Date().toISOString().slice(0, 10)
  grants[plugin] = { integrity, rules: { ...current, ...Object.fromEntries(keys.map((k) => [k, today])) } }
  writeGrants(file, grants)
}

export function revoke(file: string, plugin: string) {
  const grants = readGrants(file)
  const had = Boolean(grants[plugin])
  delete grants[plugin]
  if (Object.keys(grants).length) writeGrants(file, grants)
  else if (existsSync(grantsPath(file))) rmSync(grantsPath(file))
  return had
}

export interface LogEntry {
  plugin: string
  kind: string
  detail: string
  decision: 'allowed' | 'asked:once' | 'asked:always' | 'denied' | 'undeclared' | 'wrote' | 'declined'
}

export function audit(file: string, entry: LogEntry) {
  try {
    ensureDir(file)
    appendFileSync(logPath(file), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
  } catch {
    // Logging must never stop a run (a read-only checkout, say).
  }
}
