import type { LinkKind, NodeKind, NodeStatus } from '../../core/types.ts'

// Four hue families, validated together against the #080F11 surface (dataviz validator,
// --mode dark --pairs all). Kinds inside a family differ by dash pattern, and every
// edge carries a text label on hover, so identity never rests on color alone.
export const FAMILIES = {
  traffic: { name: 'Traffic', line: '#1DAA6C', packet: '#7BEBB4' },
  control: { name: 'Control', line: '#5C86F4', packet: '#A9BEFF' },
  data: { name: 'Data out', line: '#DD6A2E', packet: '#FFAE7D' },
  telemetry: { name: 'Telemetry', line: '#C452C0', packet: '#EFA3EC' },
  supply: { name: 'Supply', line: '#7E8385', packet: '#C9CFD1' },
  admin: { name: 'Admin', line: '#4D5558', packet: '#9AA2A5' },
} as const

export type Family = keyof typeof FAMILIES

const SOLID = undefined
const DASHED = '6 4'
const DOTTED = '1.5 4'
const DASH_DOT = '10 4 2 4'

export interface KindStyle {
  label: string
  family: Family
  dash?: string
  /** Packet speed in px/s. */
  speed: number
}

export const KINDS: Record<LinkKind, KindStyle> = {
  http: { label: 'Public HTTP', family: 'traffic', dash: SOLID, speed: 170 },
  control: { label: 'Kubernetes API', family: 'control', dash: SOLID, speed: 120 },
  storage: { label: 'Object storage', family: 'data', dash: SOLID, speed: 110 },
  mail: { label: 'Mail', family: 'data', dash: DASHED, speed: 90 },
  logs: { label: 'Logs', family: 'telemetry', dash: SOLID, speed: 95 },
  metrics: { label: 'Metrics', family: 'telemetry', dash: DASHED, speed: 70 },
  errors: { label: 'Errors', family: 'telemetry', dash: DOTTED, speed: 120 },
  ci: { label: 'Images / CI', family: 'supply', dash: SOLID, speed: 80 },
  certs: { label: 'Certificates', family: 'supply', dash: DASHED, speed: 60 },
  dns: { label: 'DNS', family: 'supply', dash: DOTTED, speed: 140 },
  ssh: { label: 'Admin SSH', family: 'admin', dash: DASH_DOT, speed: 60 },
}

export const KIND_ORDER = Object.keys(KINDS) as LinkKind[]

/** Layers that start hidden: they cross the whole canvas and matter less day to day. */
export const HIDDEN_BY_DEFAULT: LinkKind[] = ['certs', 'ssh']

export const kindColor = (kind: LinkKind) => FAMILIES[KINDS[kind].family]

export const NODE_KIND_LABEL: Record<NodeKind, string> = {
  users: 'Users',
  workstation: 'Workstation',
  proxy: 'Load balancer',
  'control-plane': 'Control plane',
  worker: 'Worker',
  server: 'Server',
  saas: 'Service',
}

export const STATUS_LABEL: Record<NodeStatus, string> = {
  active: 'Active',
  idle: 'Idle',
  degraded: 'Degraded',
  planned: 'Planned',
  retired: 'Retired',
}
