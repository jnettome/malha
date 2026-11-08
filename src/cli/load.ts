import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Ajv, type ErrorObject } from 'ajv'
import { parseDocument } from 'yaml'
import type { Topology } from '../core/types.ts'
import { checkReferences } from '../core/validate.ts'

/** The JSON Schema shipped with the package, at the package root in both src/ and dist/ layouts. */
export const SCHEMA_FILE = fileURLToPath(new URL('../../schema/topology.schema.json', import.meta.url))

export interface Loaded {
  data?: Topology
  errors: string[]
  warnings: string[]
}

// `/nodes/3/hardware/cpu` → `nodes[3] (w1).hardware.cpu`, so the message names the item.
function where(data: unknown, path: string) {
  let cursor: unknown = data
  let out = ''
  for (const part of path.split('/').slice(1)) {
    cursor = (cursor as Record<string, unknown> | undefined)?.[part]
    if (/^\d+$/.test(part)) {
      const id = (cursor as { id?: unknown; name?: unknown } | undefined)?.id ?? (cursor as { name?: unknown } | undefined)?.name
      out += `[${part}]${typeof id === 'string' ? ` (${id})` : ''}`
    } else {
      out += out ? `.${part}` : part
    }
  }
  return out || '(root)'
}

function describe(data: unknown, e: ErrorObject) {
  const detail =
    e.keyword === 'additionalProperties'
      ? `unknown field "${(e.params as { additionalProperty: string }).additionalProperty}"`
      : e.keyword === 'enum'
        ? `${e.message}: ${(e.params as { allowedValues: unknown[] }).allowedValues.join(', ')}`
        : e.message
  return `${where(data, e.instancePath)}: ${detail}`
}

let validator: ReturnType<Ajv['compile']> | undefined

/** Parse, check against the schema, then check cross-references. Never throws for bad input. */
export function loadTopology(file: string): Loaded {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    return { errors: [`cannot read ${file}: ${(e as Error).message}`], warnings: [] }
  }
  return checkTopology(text)
}

/** The same checks on topology text that is not on disk yet. */
export function checkTopology(text: string): Loaded {
  const doc = parseDocument(text)
  if (doc.errors.length) return { errors: doc.errors.map((e) => e.message), warnings: [] }
  const data = doc.toJS() as unknown

  validator ??= new Ajv({ allErrors: true }).compile(JSON.parse(readFileSync(SCHEMA_FILE, 'utf8')))
  if (!validator(data)) {
    // oneOf failures repeat once per branch; keep the first message per path.
    const seen = new Set<string>()
    const errors = (validator.errors ?? [])
      .filter((e) => e.keyword !== 'oneOf' && !seen.has(e.instancePath) && seen.add(e.instancePath))
      .map((e) => describe(data, e))
    return { errors, warnings: [] }
  }
  const topology = data as Topology
  return { data: topology, ...checkReferences(topology) }
}
