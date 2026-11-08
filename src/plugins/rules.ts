import { homedir } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'

// Permission patterns from malha-plugin.json, and matching calls against them.
//
//   exec   "kubectl [--context *] get nodes -o json"
//          Whitespace-separated tokens. `*` matches one argument that does not start with `-`, so it
//          can never smuggle in a flag. `[...]` makes the tokens inside optional. The first token is a
//          program name looked up on the user's PATH; paths are not allowed.
//   fetch  "https://api.example.com/v1/*"  or  "GET,POST https://api.example.com/v1/*"
//          Exact scheme, host and port (a leading `*.` allows subdomains); `*` in the path matches
//          anything. GET and HEAD unless methods are named.
//   files  "~/.config/example/token"  `*` matches within one path segment, `**` across segments.
//   env    "EXAMPLE_TOKEN"  exact names.

export type Kind = 'exec' | 'fetch' | 'files' | 'env'

export interface Rule {
  kind: Kind
  /** The pattern as written; with `kind`, the key approvals are stored under. */
  pattern: string
}

export const ruleKey = (r: Rule) => `${r.kind}:${r.pattern}`

type Token = { literal: string } | { any: true } | { optional: Token[] }

/** Programs that run arbitrary code, so a pattern for them is as good as no sandbox. */
const OPEN_ENDED = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'env', 'xargs', 'sudo', 'doas', 'su', 'node', 'deno', 'bun', 'npx', 'python', 'python3', 'perl', 'ruby', 'php', 'pwsh', 'powershell', 'cmd', 'osascript', 'eval', 'exec', 'nohup', 'timeout', 'watch'])

function tokenize(pattern: string): { program: string; tokens: Token[] } {
  const words = pattern.match(/\[|\]|[^\s[\]]+/g) ?? []
  const [program, ...rest] = words
  if (!program || program === '*' || program === '[' || program === ']') throw new Error(`exec pattern "${pattern}" must start with a program name`)
  if (program.includes('/') || program.includes('\\')) throw new Error(`exec pattern "${pattern}": name the program, not a path; it is looked up on PATH`)
  const tokens: Token[] = []
  let group: Token[] | undefined
  for (const w of rest) {
    if (w === '[') {
      if (group) throw new Error(`exec pattern "${pattern}": [ ] groups do not nest`)
      group = []
    } else if (w === ']') {
      if (!group) throw new Error(`exec pattern "${pattern}": unmatched ]`)
      tokens.push({ optional: group })
      group = undefined
    } else (group ?? tokens).push(w === '*' ? { any: true } : { literal: w })
  }
  if (group) throw new Error(`exec pattern "${pattern}": unclosed [`)
  return { program, tokens }
}

function matchTokens(tokens: Token[], args: string[]): boolean {
  if (!tokens.length) return !args.length
  const [t, ...rest] = tokens
  if ('optional' in t) return matchTokens([...t.optional, ...rest], args) || matchTokens(rest, args)
  if (!args.length) return false
  const [a, ...more] = args
  if ('any' in t) return a !== '' && !a.startsWith('-') && matchTokens(rest, more)
  return a === t.literal && matchTokens(rest, more)
}

export function matchExec(pattern: string, command: string, args: string[]) {
  const { program, tokens } = tokenize(pattern)
  return command === program && matchTokens(tokens, args)
}

/** Why a pattern deserves a second look, shown when the plugin is reviewed. */
export function execWarning(pattern: string) {
  const { program } = tokenize(pattern)
  return OPEN_ENDED.has(program) ? `${program} can run any code outside the sandbox` : undefined
}

const glob = (pattern: string, star: string, globstar = star) =>
  new RegExp(
    `^${pattern
      .split('**')
      .map((part) => part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join(star))
      .join(globstar)}$`,
  )

interface FetchPattern {
  methods: string[]
  scheme: string
  host: string
  subdomains: boolean
  port: string
  path: RegExp
}

function parseFetch(pattern: string): FetchPattern {
  const m = pattern.trim().match(/^(?:([A-Z]+(?:,[A-Z]+)*)\s+)?(https?):\/\/(\*\.)?([a-z0-9.-]+)(?::(\d+))?(\/\S*)?$/i)
  if (!m) throw new Error(`fetch pattern "${pattern}" must look like "https://host/path*" with an optional "GET,POST " in front`)
  const [, methods, scheme, sub, host, port, path] = m
  return {
    methods: methods ? methods.split(',') : ['GET', 'HEAD'],
    scheme: scheme.toLowerCase(),
    host: host.toLowerCase(),
    subdomains: Boolean(sub),
    port: port ?? '',
    path: glob(path ?? '/', '.*'),
  }
}

export function matchFetch(pattern: string, method: string, url: string) {
  const p = parseFetch(pattern)
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  const host = u.hostname.toLowerCase()
  return (
    p.methods.includes(method.toUpperCase()) &&
    u.protocol === `${p.scheme}:` &&
    !u.username &&
    !u.password &&
    (host === p.host || (p.subdomains && host.endsWith(`.${p.host}`))) &&
    u.port === p.port &&
    p.path.test(u.pathname)
  )
}

const expand = (path: string) => (path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path)

/** The absolute, normalised path a plugin asked for, or undefined if it is not absolute (after ~). */
export function resolveFile(path: string) {
  const full = expand(path)
  return isAbsolute(full) ? normalize(full) : undefined
}

export function matchFile(pattern: string, path: string) {
  const resolved = resolveFile(path)
  const base = resolveFile(pattern)
  return Boolean(resolved && base && glob(base, '[^/]*', '.*').test(resolved))
}

export const matchEnv = (pattern: string, name: string) => pattern === name

// A fetch pattern may take its host from the project's options: "GET {options.hosts}/api/*". The value
// must be an origin (scheme, host, port; no path, wildcard or credentials), or a list of them, each
// giving one pattern. The person approves the expanded patterns, so they see the real hosts.
const TEMPLATE = /\{options\.([A-Za-z0-9_]+)\}/
const TEMPLATED = /^(?:[A-Z]+(?:,[A-Z]+)*\s+)?\{options\.[A-Za-z0-9_]+\}\/\S*$/

function originOf(value: unknown) {
  if (typeof value !== 'string') return undefined
  try {
    const u = new URL(value)
    const bare = (u.pathname === '/' || u.pathname === '') && !u.search && !u.hash && !u.username && !u.password
    return /^https?:$/.test(u.protocol) && bare && !value.includes('*') ? u.origin : undefined
  } catch {
    return undefined
  }
}

/** Fill {options.key} in fetch patterns. Patterns whose option is missing or invalid are dropped, with a problem. */
export function expandPatterns(patterns: string[] = [], options: Record<string, unknown> = {}) {
  const out: string[] = []
  const problems: string[] = []
  for (const pattern of patterns) {
    const m = pattern.match(TEMPLATE)
    if (!m) {
      out.push(pattern)
      continue
    }
    const values = options[m[1]] === undefined ? [] : [options[m[1]]].flat()
    if (!values.length) problems.push(`${pattern}: set options.${m[1]} in malha.plugins.json`)
    for (const value of values) {
      const origin = originOf(value)
      if (origin) out.push(pattern.replace(m[0], origin))
      else problems.push(`options.${m[1]}: "${String(value)}" is not an origin like https://analytics.example.com`)
    }
  }
  return { patterns: [...new Set(out)], problems }
}

/** Check every pattern parses; returns problems as messages. */
export function checkPatterns(permissions: Partial<Record<Kind, string[]>>) {
  const problems: string[] = []
  for (const p of permissions.exec ?? []) {
    try {
      tokenize(p)
    } catch (e) {
      problems.push((e as Error).message)
    }
  }
  for (const p of permissions.fetch ?? []) {
    if (TEMPLATE.test(p) && !TEMPLATED.test(p)) {
      problems.push(`fetch pattern "${p}": {options.…} must be the whole host, right after the methods`)
      continue
    }
    try {
      parseFetch(p.replace(TEMPLATE, 'https://options.invalid'))
    } catch (e) {
      problems.push((e as Error).message)
    }
  }
  for (const p of permissions.files ?? []) if (!resolveFile(p)) problems.push(`files pattern "${p}" must be absolute or start with ~/`)
  for (const p of permissions.env ?? []) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p)) problems.push(`env "${p}" is not a variable name`)
  return problems
}

/** The first declared pattern that allows this call. */
export function findRule(permissions: Partial<Record<Kind, string[]>>, kind: Kind, test: (pattern: string) => boolean): Rule | undefined {
  const pattern = (permissions[kind] ?? []).find(test)
  return pattern === undefined ? undefined : { kind, pattern }
}
