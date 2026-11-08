import { useSyncExternalStore } from 'react'
import type { Answer, LiveSnapshot } from '../core/live.ts'
import type { InfraNode, NodeStatus } from '../core/types.ts'
import { events, isLive } from './source.ts'

// Live plugin data from `malha dev`: the latest snapshot, pushed over the event stream. In a static
// build there is none, and every hook falls back to the values in the file.

let snapshot: LiveSnapshot | null = null
const listeners = new Set<() => void>()
const set = (next: LiveSnapshot | null) => {
  snapshot = next
  for (const l of listeners) l()
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function startLive() {
  if (!isLive()) return
  events()?.addEventListener('live', (e) => set(JSON.parse((e as MessageEvent<string>).data) as LiveSnapshot))
  fetch('api/live.json', { cache: 'no-store' })
    .then((r) => (r.ok ? (r.json() as Promise<LiveSnapshot | null>) : null))
    .then((s) => snapshot === null && set(s))
    .catch(() => undefined)
}

export const useLive = () => useSyncExternalStore(subscribe, () => snapshot)

/** A node's usage and status: live values where a plugin sent them, else the sampled ones. */
export function useLiveNode(n: InfraNode) {
  const live = useLive()?.nodes[n.id]
  const usage = live
    ? { ...n.usage, ...(live.cpu_pct !== undefined && { cpu_pct: live.cpu_pct }), ...(live.memory_pct !== undefined && { memory_pct: live.memory_pct }), ...(live.pods !== undefined && { pods: live.pods }) }
    : n.usage
  const status: NodeStatus = live?.status ?? n.status ?? 'active'
  return { usage, status, live }
}

const token = () => document.querySelector<HTMLMetaElement>('meta[name="malha-token"]')?.content ?? ''

/** Answer a plugin's question. Resolves to an error message, or undefined when accepted. */
export async function answer(id: string, value: Answer) {
  const res = await fetch('api/answer', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-malha-token': token() },
    body: JSON.stringify({ id, answer: value }),
  }).catch(() => undefined)
  if (!res) return 'Malha is not running any more.'
  if (res.status === 404) return undefined // answered in another tab
  if (!res.ok) return ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`
}
