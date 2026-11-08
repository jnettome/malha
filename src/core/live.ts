// Shapes shared by `malha dev` (src/plugins/live.ts) and the viewer (src/viewer/live.ts).

import type { NodeStatus } from './types.ts'

export interface LiveNode {
  cpu_pct?: number
  memory_pct?: number
  pods?: number
  status?: NodeStatus
}

export type PermissionKind = 'exec' | 'fetch' | 'files' | 'env'

/** Yes for this run (or this `malha dev`), yes and don't ask again, or no. */
export type Answer = 'once' | 'always' | 'deny'

/** A plugin wants to do something not yet approved. */
export interface Question {
  plugin: string
  version: string
  hash: string
  kind: PermissionKind
  /** The concrete request, e.g. `kubectl get nodes -o json`. */
  detail: string
  /** The manifest pattern it falls under; "always" approves this pattern. */
  rule: string
  network: string
}

export interface Ask {
  id: string
  question: Question
}

export interface PluginStatus {
  name: string
  every: number
  state: 'starting' | 'asking' | 'ok' | 'error' | 'stopped'
  message?: string
  at?: string
}

export interface LiveSnapshot {
  plugins: PluginStatus[]
  /** Latest values per node id, from whichever plugin reported last. */
  nodes: Record<string, LiveNode & { plugin: string; at: string }>
  asks: Ask[]
  network: string
}
