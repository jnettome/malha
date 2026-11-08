import { registeredDomain } from '../../core/hostnames.ts'
import { apps, model } from '../model/model.ts'
import type { App, Domain, InfraNode } from '../../core/types.ts'

export const domainList: Domain[] = model.t.domains?.list ?? []
export const domainsChecked = model.t.domains?.checked
export const domainSources = model.t.domains?.sources ?? []

/** Days left that count as urgent: renew now. */
export const URGENT_DAYS = 45
/** Days left shown as "renew soon". */
export const SOON_DAYS = 90

export interface DomainUse {
  apps: App[]
  nodes: InfraNode[]
  /** Hostnames under this domain that something in the map answers on. */
  hosts: string[]
}

const uses = new Map<string, DomainUse>()
const use = (name: string) => {
  const u = uses.get(name) ?? { apps: [], nodes: [], hosts: [] }
  uses.set(name, u)
  return u
}
for (const a of apps) {
  for (const host of a.domains ?? []) {
    const u = use(registeredDomain(host))
    if (!u.apps.includes(a)) u.apps.push(a)
    u.hosts.push(host)
  }
}
for (const n of model.nodes) {
  if (!n.host) continue
  const u = use(registeredDomain(n.host))
  u.nodes.push(n)
  u.hosts.push(n.host)
}

export const usesOf = (name: string): DomainUse => uses.get(name) ?? { apps: [], nodes: [], hosts: [] }

const DAY = 86_400_000

/** Whole days from today (local midnight) to the expiry date; negative once expired. */
export function daysLeft(expires: string | undefined, today = new Date()) {
  if (!expires) return undefined
  const [y, m, d] = expires.split('-').map(Number)
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  return Math.round((new Date(y, m - 1, d).getTime() - start.getTime()) / DAY)
}

export const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 })
