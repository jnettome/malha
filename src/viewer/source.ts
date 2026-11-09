import { normalizeAnalytics, type AnalyticsFile } from '../core/analytics.ts'
import type { SecurityScan } from '../core/security.ts'
import type { Topology } from '../core/types.ts'

// Where the viewer's data comes from. `malha build` embeds it in index.html as JSON script tags;
// `malha dev` serves it under api/ and pushes `change` events when the files on disk change.

const embedded = <T,>(id: string): T | undefined => {
  const el = document.getElementById(id)
  return el?.textContent ? (JSON.parse(el.textContent) as T) : undefined
}

export class DataError extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
  ) {
    super(message)
  }
}

/** The topology every module reads. Set by loadTopology() before the app is imported. */
export let topology: Topology

export const isLive = () => !document.getElementById('malha-topology')

export async function loadTopology() {
  const inline = embedded<Topology>('malha-topology')
  if (inline) {
    topology = inline
    return
  }
  const res = await fetch('api/topology.json', { cache: 'no-store' })
  const body = (await res.json().catch(() => ({}))) as Topology & { errors?: string[]; file?: string }
  if (!res.ok) throw new DataError(`${body.file ?? 'The topology file'} is invalid`, body.errors ?? [`HTTP ${res.status}`])
  topology = body
}

/** Traffic from `malha analytics refresh`, or null when there is none yet. */
export async function loadAnalytics(): Promise<AnalyticsFile | null> {
  const el = document.getElementById('malha-analytics')
  if (el) return normalizeAnalytics(embedded<unknown>('malha-analytics'))
  if (!isLive()) return null
  const res = await fetch('api/analytics.json', { cache: 'no-store' })
  return res.ok ? normalizeAnalytics(await res.json()) : null
}

/** The dependency scan, or null when there is none yet. */
export async function loadScan(): Promise<SecurityScan | null> {
  const el = document.getElementById('malha-scan')
  if (el) return embedded<SecurityScan>('malha-scan') ?? null
  if (!isLive()) return null
  const res = await fetch('api/scan.json', { cache: 'no-store' })
  return res.ok ? ((await res.json()) as SecurityScan | null) : null
}

let stream: EventSource | undefined

/** The `malha dev` event stream, or undefined in a static build. */
export function events() {
  if (!stream && isLive() && typeof EventSource !== 'undefined') stream = new EventSource('api/events')
  return stream
}

/** Reload the page when `malha dev` reports a change to the topology or the scan. */
export function followChanges() {
  events()?.addEventListener('change', () => location.reload())
}
