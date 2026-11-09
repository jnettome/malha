// Mirrors infra/topology.schema.json. Keep the two in step.

import type { AnalyticsSource } from './analytics.ts'
import type { Accepted } from './check.ts'

export type LinkKind =
  | 'http'
  | 'control'
  | 'dns'
  | 'logs'
  | 'metrics'
  | 'errors'
  | 'storage'
  | 'mail'
  | 'ci'
  | 'certs'
  | 'ssh'

export type NodeKind = 'users' | 'workstation' | 'proxy' | 'control-plane' | 'worker' | 'server' | 'saas'
export type NodeStatus = 'active' | 'idle' | 'degraded' | 'planned' | 'retired'
export type Notes = string | string[]

export interface Meta {
  name: string
  cluster?: string
  kubernetes?: string
  runtime?: string
  checked: string
  maintainer?: string
  sources?: string[]
  /** When the per-app pod counts were sampled. */
  pods_sampled?: string
}

export interface Provider {
  id: string
  name: string
  kind: 'datacenter' | 'cloud' | 'saas' | 'home'
  location?: string
  asn?: string
  network?: string
  notes?: Notes
}

export interface Network {
  id: string
  name: string
  kind: 'public' | 'overlay' | 'private' | 'lan'
  cidr?: string
  port?: number
  notes?: Notes
}

export interface Site {
  id: string
  name: string
  region?: string
  lat: number
  lon: number
  notes?: Notes
}

export interface Zone {
  id: string
  name: string
  description?: string
  column: number
  row?: number
  stack?: 'vertical' | 'horizontal'
}

export interface InfraNode {
  id: string
  name: string
  kind: NodeKind
  zone: string
  status?: NodeStatus
  provider?: string
  /** One site, or several for a service that spans regions. */
  site?: string | string[]
  host?: string
  addresses?: Record<string, string>
  networks?: string[]
  os?: string
  ssh?: { port?: number; user?: string }
  hardware?: {
    model?: string
    cpu?: number
    cpu_model?: string
    memory_gib?: number
    gpu?: string
    max_pods?: number
    disks?: string[]
  }
  usage?: { cpu_pct?: number; memory_pct?: number; pods?: number; sampled?: string }
  runs?: string[]
  since?: string
  tags?: string[]
  notes?: Notes
  docs?: string[]
}

export type Endpoint = string | string[]

export interface Link {
  from: Endpoint
  to: Endpoint
  kind: LinkKind
  label?: string
  ports?: number[]
  via?: string
  status?: 'active' | 'inactive'
  notes?: Notes
}

export interface Database {
  name: string
  engine: 'postgres' | 'mysql' | 'redis' | 'elasticsearch' | 'tsdb' | 'other'
  nodes: string[]
}

export interface App {
  id: string
  name: string
  category: 'product' | 'platform' | 'internal' | 'staging'
  /** One namespace, or several when the app spans them. */
  namespace?: string | string[]
  domains?: string[]
  pods?: Record<string, number>
  host?: string
  databases?: Database[]
  /** Git remotes the app's images are built from, e.g. gitlab.com/group/project. */
  repos?: string[]
  uses?: string[]
  depends_on?: string[]
  /** Where its traffic is measured; `malha analytics detect` proposes these. */
  analytics?: AnalyticsSource[]
  notes?: Notes
}

export interface Domain {
  name: string
  registrar?: string
  expires?: string
  auto_renew?: boolean
  dns?: string
  plan?: string
  visitors?: number
  insights?: number
  notes?: Notes
}

export interface FlowStep {
  from: string
  to: string
  label: string
  via?: string
}

export interface Flow {
  id: string
  name: string
  kind: LinkKind
  steps: FlowStep[]
}

export interface Topology {
  version: 1
  meta: Meta
  providers?: Provider[]
  networks?: Network[]
  sites?: Site[]
  zones: Zone[]
  nodes: InfraNode[]
  links?: Link[]
  apps?: App[]
  domains?: { checked: string; sources?: string[]; list: Domain[] }
  flows?: Flow[]
  /** Findings of `malha check` that are known and accepted, with the reason. */
  accepted?: Accepted[]
}
