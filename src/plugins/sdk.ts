// The plugin API: what a plugin's entry module exports, and the `ctx` it is called with.
// Plugin authors get these types from `malha/plugin`. Docs: docs/plugins.md.

import type { CheckFinding } from '../core/check.ts'
import type { LiveNode } from '../core/live.ts'
import type { Topology } from '../core/types.ts'

export type { CheckFinding, LiveNode, Topology }

/** What `exec` returns. A non-zero exit code is not an error; check `code`. */
export interface ExecResult {
  stdout: string
  stderr: string
  code: number
}

export interface FetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string
}

/**
 * Everything a plugin can reach outside its own folder. Each call is checked against the
 * plugin's malha-plugin.json and, unless the user already allowed it, asked about first.
 * A refused call rejects with an error whose `code` is `MALHA_DENIED`.
 */
export interface PluginContext {
  /** This plugin's `options` from malha.plugins.json. */
  options: Record<string, unknown>
  /** Arguments after `--` on the command line. */
  args: string[]
  /** Today's date, YYYY-MM-DD, in the user's time zone. */
  today: string
  /** The topology as parsed JSON. Needs `"topology": "read"` or `"propose"`. */
  topology(): Promise<Topology>
  /** Run a program from the user's PATH, without a shell. Must match a `permissions.exec` pattern. */
  exec(command: string, args: string[]): Promise<ExecResult>
  /** An HTTP request made by Malha. Must match a `permissions.fetch` pattern. Redirects are not followed. */
  fetch(url: string, init?: FetchInit): Promise<Response>
  /** A UTF-8 file outside the plugin folder. Must match a `permissions.files` pattern. */
  readFile(path: string): Promise<string>
  /** An environment variable, or undefined when unset. Must be listed in `permissions.env`. */
  env(name: string): Promise<string | undefined>
}

/** Collections a change can add to or update, and the field that identifies their items. */
export const COLLECTIONS = {
  providers: 'id',
  networks: 'id',
  sites: 'id',
  zones: 'id',
  nodes: 'id',
  links: undefined,
  apps: 'id',
  flows: 'id',
  domains: 'name',
} as const
export type Collection = keyof typeof COLLECTIONS

/**
 * One proposed edit to the topology file. Changes add and update; they never delete.
 * `set` keys may be dotted paths (`usage.cpu_pct`); each value replaces what is at that path.
 * A change with only `set` works from the top of the file, under `meta.` or `domains.` (checked, sources).
 */
export type Change =
  | { add: Collection; item: Record<string, unknown>; why?: string }
  | { update: Exclude<Collection, 'links'>; id: string; set: Record<string, unknown>; why?: string }
  | { meta: Record<string, unknown>; why?: string }
  | { set: Record<string, unknown>; why?: string }

export interface CommandResult {
  /** Proposed edits. Malha validates them, shows the diff, and writes only if the user agrees. */
  changes?: Change[]
  /** A line or two for the terminal. */
  message?: string
}

/** What a `live` plugin returns; the open viewer shows it in place of the sampled values. */
export interface LiveData {
  nodes?: Record<string, LiveNode>
}

/** What `malha check --notify` hands a notifier plugin. */
export interface CheckReport {
  /** meta.name of the topology. */
  project: string
  /** The command to see everything, e.g. `malha check infra/topology.yaml`. */
  command: string
  /** All open findings, after accepted ones. */
  open: number
  /** What to announce: new or worse since the last notice (or every open finding, for a digest). */
  findings: CheckFinding[]
  /** Findings announced before that are gone now. */
  resolved: { id: string; title: string }[]
  digest: boolean
}

export interface NotifyResult {
  sent: boolean
  /** Why nothing was sent, or where it went. */
  message?: string
}

export interface Plugin {
  /** `malha <plugin> <command>` runs `commands[command]`. */
  commands?: Record<string, (ctx: PluginContext) => Promise<CommandResult | void>>
  /** Called every `live.every` seconds while `malha dev` runs. */
  live?: (ctx: PluginContext) => Promise<LiveData>
  /** Called by `malha check --notify` with what to announce. */
  notify?: (ctx: PluginContext, report: CheckReport) => Promise<NotifyResult>
}

/** malha-plugin.json */
export interface Manifest {
  name: string
  version: string
  description: string
  main: string
  permissions: {
    exec?: string[]
    fetch?: string[]
    files?: string[]
    env?: string[]
    topology?: 'none' | 'read' | 'propose'
  }
  commands?: Record<string, string>
  live?: { every: number; description?: string }
  notify?: { description?: string }
}
