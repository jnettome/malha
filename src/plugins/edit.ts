import { isDeepStrictEqual } from 'node:util'
import { isMap, isScalar, isSeq, parse, parseDocument, type Document, type Pair, type YAMLMap, type YAMLSeq } from 'yaml'
import { COLLECTIONS, type Change, type Collection } from './sdk.ts'

// Plugins propose changes; this applies them to the topology text without disturbing anything else.
// Each atomic edit replaces or inserts text at the exact range of the YAML node it touches, in the
// style already around it (inline `{ }` maps stay inline, blank lines between items stay). After
// all edits the new text must parse to exactly the data the changes describe, or nothing is written.

export interface Proposal {
  text: string
  /** One line per change that alters something, with its index in the input. */
  applied: { change: number; summary: string }[]
  /** Changes that were refused, and why. */
  problems: string[]
}

type Range = [number, number, number]
const range = (node: unknown) => (node as { range: Range }).range

const PATH = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const ROOT_PATHS = /^(meta\.[A-Za-z0-9_.-]+|domains\.(checked|sources))$/

function jsonProblem(v: unknown, depth = 0): string | undefined {
  if (depth > 8) return 'is nested too deeply'
  if (v === null || typeof v === 'boolean') return
  if (typeof v === 'number') return Number.isFinite(v) ? undefined : 'is not a finite number'
  if (typeof v === 'string') return v.length > 10_000 ? 'is a string over 10,000 characters' : undefined
  if (Array.isArray(v)) {
    if (v.length > 1000) return 'is a list over 1,000 items'
    for (const x of v) {
      const p = jsonProblem(x, depth + 1)
      if (p) return p
    }
    return
  }
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    for (const [k, x] of Object.entries(v)) {
      if (FORBIDDEN_KEYS.has(k)) return `uses the key "${k}"`
      const p = jsonProblem(x, depth + 1)
      if (p) return p
    }
    return
  }
  return 'is not plain JSON data'
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Check a plugin's `changes` before touching anything. Returns the usable ones and the problems. */
export function checkChanges(raw: unknown) {
  const ok: Change[] = []
  const problems: string[] = []
  if (!Array.isArray(raw)) return { ok, problems: raw === undefined ? [] : ['changes is not a list'] }
  if (raw.length > 2000) return { ok, problems: ['more than 2,000 changes'] }
  raw.forEach((c, i) => {
    const at = `change ${i + 1}`
    if (!isObject(c)) return problems.push(`${at} is not an object`)
    const kinds = ['add', 'update', 'meta'].filter((k) => k in c)
    if (kinds.length > 1 || (!kinds.length && !('set' in c))) return problems.push(`${at} needs exactly one of add, update, meta or set`)
    if (c.why !== undefined && (typeof c.why !== 'string' || c.why.length > 300)) return problems.push(`${at}: why must be a short string`)
    const bad = jsonProblem(c)
    if (bad) return problems.push(`${at} ${bad}`)
    const paths = (set: unknown, idField?: string) => {
      if (!isObject(set) || !Object.keys(set).length) return 'needs a non-empty set'
      for (const key of Object.keys(set)) {
        if (!PATH.test(key)) return `has a bad path "${key}"`
        if (key.split('.').some((s) => FORBIDDEN_KEYS.has(s))) return `has a bad path "${key}"`
        if (idField && key.split('.')[0] === idField) return `cannot change ${idField}`
        if (set[key] === null) return `sets ${key} to null; changes never delete`
      }
    }
    if ('add' in c) {
      if (!(typeof c.add === 'string' && c.add in COLLECTIONS)) return problems.push(`${at}: cannot add to "${String(c.add)}"`)
      if (!isObject(c.item)) return problems.push(`${at}: item must be an object`)
      const idField = COLLECTIONS[c.add as Collection]
      if (idField && (typeof c.item[idField] !== 'string' || !c.item[idField])) return problems.push(`${at}: the new item needs a ${idField}`)
    } else if ('update' in c) {
      if (!(typeof c.update === 'string' && c.update in COLLECTIONS && c.update !== 'links')) return problems.push(`${at}: cannot update "${String(c.update)}"`)
      if (typeof c.id !== 'string') return problems.push(`${at}: update needs an id`)
      const p = paths(c.set, COLLECTIONS[c.update as Collection])
      if (p) return problems.push(`${at} ${p}`)
    } else if ('meta' in c) {
      const p = paths(c.meta)
      if (p) return problems.push(`${at} ${p}`)
    } else {
      const p = paths(c.set)
      if (p) return problems.push(`${at} ${p}`)
      const outside = Object.keys(c.set as object).find((k) => !ROOT_PATHS.test(k))
      if (outside) return problems.push(`${at}: set from the top of the file only reaches meta.* and domains.checked or domains.sources, not "${outside}"`)
    }
    ok.push(c as Change)
  })
  return { ok, problems }
}

// ---- The intended result, as data --------------------------------------------------------------

const nest = (path: string[], value: unknown): unknown => (path.length ? { [path[0]]: nest(path.slice(1), value) } : value)

function setData(target: Record<string, unknown>, path: string[], value: unknown) {
  const [key, ...rest] = path
  if (!rest.length) target[key] = structuredClone(value)
  else if (isObject(target[key])) setData(target[key] as Record<string, unknown>, rest, value)
  else target[key] = nest(rest, structuredClone(value))
}

function getData(target: unknown, path: string[]): unknown {
  return path.reduce<unknown>((at, key) => (isObject(at) ? at[key] : undefined), target)
}

const listOf = (data: Record<string, unknown>, coll: Collection) =>
  (coll === 'domains' ? (data.domains as { list?: unknown[] } | undefined)?.list : data[coll]) as Record<string, unknown>[] | undefined

// ---- Text edits ----------------------------------------------------------------------------------

const lineStart = (text: string, pos: number) => text.lastIndexOf('\n', pos - 1) + 1
const column = (text: string, pos: number) => pos - lineStart(text, pos)
const lineEnd = (text: string, pos: number) => {
  const i = text.indexOf('\n', pos)
  return i === -1 ? text.length : i
}
/** Back over trailing whitespace, not past `min`. */
const contentEnd = (text: string, end: number, min = 0) => {
  while (end > min && /\s/.test(text[end - 1])) end--
  return end
}
const splice = (text: string, start: number, end: number, insert: string) => text.slice(0, start) + insert + text.slice(end)

function plainOk(s: string) {
  if (!s || s !== s.trim() || /[\n\r\t]/.test(s)) return false
  try {
    return (parse(`k: ${s}`) as { k: unknown })?.k === s && (parse(`k: [${s}]`) as { k: unknown[] })?.k?.[0] === s && (parse(`{ k: ${s} }`) as { k: unknown })?.k === s
  } catch {
    return false
  }
}
const str = (s: string) => (plainOk(s) ? s : JSON.stringify(s))

/** One line of YAML for a value: plain scalars where they read back the same, inline collections. */
export function render(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'string') return str(v)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return `[${v.map(render).join(', ')}]`
  const entries = Object.entries(v as object)
  return entries.length ? `{ ${entries.map(([k, x]) => `${str(k)}: ${render(x)}`).join(', ')} }` : '{}'
}

const keyOf = (p: Pair) => (isScalar(p.key) ? String(p.key.value) : undefined)

function insertPair(text: string, map: YAMLMap, key: string, value: unknown) {
  const last = map.items.at(-1)
  if (map.flow) {
    if (!last) return splice(text, range(map)[0], range(map)[1], `{ ${str(key)}: ${render(value)} }`)
    const end = last.value ? range(last.value)[1] : range(last.key)[1]
    return splice(text, end, end, `, ${str(key)}: ${render(value)}`)
  }
  if (!last) throw new Error('cannot add to an empty block map')
  const indent = ' '.repeat(column(text, range(map.items[0].key)[0]))
  const end = last.value ? contentEnd(text, range(last.value)[1], range(last.value)[0]) : range(last.key)[1]
  const at = lineEnd(text, Math.max(end, range(last.key)[1]))
  return splice(text, at, at, `\n${indent}${str(key)}: ${render(value)}`)
}

function replaceValue(text: string, pair: Pair, value: unknown) {
  const node = pair.value
  if (!node) {
    const colon = text.indexOf(':', range(pair.key)[1])
    return splice(text, colon + 1, colon + 1, ` ${render(value)}`)
  }
  const [start, valueEnd] = range(node)
  const end = contentEnd(text, valueEnd, start)
  const blockCollection = (isMap(node) || isSeq(node)) && !node.flow
  if (blockCollection && typeof value === 'object' && value !== null && Object.keys(value).length) {
    // Keep a block list or map a block, at the same indentation.
    const pad = `\n${' '.repeat(column(text, start))}`
    const lines = Array.isArray(value) ? value.map((x) => `- ${render(x)}`) : Object.entries(value).map(([k, x]) => `${str(k)}: ${render(x)}`)
    return splice(text, start, end, lines.join(pad))
  }
  return splice(text, start, end, render(value))
}

function setIn(text: string, map: YAMLMap, path: string[], value: unknown): string {
  const [key, ...rest] = path
  const pair = map.items.find((p) => keyOf(p) === key)
  if (!pair) return insertPair(text, map, key, rest.length ? nest(rest, value) : value)
  if (rest.length && isMap(pair.value)) return setIn(text, pair.value, rest, value)
  return replaceValue(text, pair, rest.length ? nest(rest, value) : value)
}

function seqOf(doc: Document.Parsed, coll: Collection) {
  const node = coll === 'domains' ? doc.getIn(['domains', 'list'], true) : doc.get(coll, true)
  return isSeq(node) ? (node as YAMLSeq) : undefined
}

function itemMap(doc: Document.Parsed, coll: Collection, id: string) {
  const field = COLLECTIONS[coll]!
  return seqOf(doc, coll)?.items.find((m): m is YAMLMap => isMap(m) && isScalar(m.get(field, true)) && String((m.get(field, true) as { value: unknown }).value) === id)
}

/**
 * Where a new item goes in a list kept sorted by its id (or name): before the first item that sorts
 * after it. -1 when the list is not sorted that way, or the item belongs at the end.
 */
export function sortedIndex(ids: unknown[], id: unknown) {
  if (typeof id !== 'string' || ids.length < 2 || !ids.every((x) => typeof x === 'string')) return -1
  const list = ids as string[]
  if (!list.every((x, i) => i === 0 || list[i - 1].localeCompare(x) <= 0)) return -1
  return list.findIndex((x) => x.localeCompare(id) > 0)
}

/** One list item in the style of `like`: a block map keyed at the same column, or one inline line. */
function renderItem(text: string, like: unknown, item: Record<string, unknown>) {
  const first = lineStart(text, range(like)[0])
  const dash = text.indexOf('-', first) - first
  if (isMap(like) && !like.flow && like.items.length) {
    const keyCol = column(text, range(like.items[0].key)[0])
    const lines = Object.entries(item).map(([k, v]) => `${str(k)}: ${render(v)}`)
    return `${' '.repeat(dash)}-${' '.repeat(Math.max(keyCol - dash - 1, 1))}${lines.join(`\n${' '.repeat(keyCol)}`)}`
  }
  return `${' '.repeat(dash)}- ${render(item)}`
}

function addItem(text: string, doc: Document.Parsed, coll: Collection, item: Record<string, unknown>, today: string) {
  const seq = seqOf(doc, coll)
  const root = doc.contents as YAMLMap
  if (!seq) {
    if (coll === 'domains') {
      const domains = doc.get('domains', true)
      if (isMap(domains)) return setIn(text, domains, ['list'], [item])
      return `${text.trimEnd()}\n\ndomains:\n  checked: ${today}\n  list:\n    - ${render(item)}\n`
    }
    if (root.items.some((p) => keyOf(p) === coll)) return setIn(text, root, [coll], [item])
    return `${text.trimEnd()}\n\n${coll}:\n  - ${render(item)}\n`
  }
  const last = seq.items.at(-1)
  if (seq.flow || !last) {
    if (!last) return splice(text, range(seq)[0], range(seq)[1], `[${render(item)}]`)
    const end = range(last)[1]
    return splice(text, end, end, `, ${render(item)}`)
  }
  const prev = seq.items.at(-2)
  const blank = prev ? /\n[ \t]*\n/.test(text.slice(contentEnd(text, range(prev)[1], range(prev)[0]), range(last)[0])) : false
  const field = COLLECTIONS[coll]
  const ids = seq.items.map((m) => (field && isMap(m) && isScalar(m.get(field, true)) ? (m.get(field, true) as { value: unknown }).value : undefined))
  const before = field ? sortedIndex(ids, item[field]) : -1
  if (before >= 0) {
    // Keep a sorted list sorted: in front of the first item that sorts after this one.
    const target = seq.items[before]
    const at = lineStart(text, range(target)[0])
    return splice(text, at, at, `${renderItem(text, target, item)}\n${blank ? '\n' : ''}`)
  }
  const at = lineEnd(text, contentEnd(text, range(last)[1], range(last)[0]))
  return splice(text, at, at, `\n${blank ? '\n' : ''}${renderItem(text, last, item)}`)
}

// ---- Putting it together ---------------------------------------------------------------------------

function describe(c: Change, keys: string[]) {
  const why = c.why ? ` (${c.why})` : ''
  if ('add' in c) {
    const id = COLLECTIONS[c.add] ? c.item[COLLECTIONS[c.add]!] : `${String(c.item.from)} → ${String(c.item.to)}`
    return `add ${c.add} ${String(id)}${why}`
  }
  if ('update' in c) return `update ${c.update} ${c.id}: ${keys.join(', ')}${why}`
  if ('meta' in c) return `meta: ${keys.join(', ')}${why}`
  return `set ${keys.join(', ')}${why}`
}

/** Apply checked changes to the topology text. Never throws for a bad change; reports it. */
export function applyChanges(text: string, changes: Change[], today: string): Proposal {
  const expected = parse(text) as Record<string, unknown>
  const applied: Proposal['applied'] = []
  const problems: string[] = []
  let out = text

  for (const [index, c] of changes.entries()) {
    const before = out
    const beforeData = structuredClone(expected)
    try {
      if ('add' in c) {
        const list = listOf(expected, c.add)
        const field = COLLECTIONS[c.add]
        if (field && list?.some((x) => x[field] === c.item[field])) throw new Error(`${c.add} already has ${String(c.item[field])}`)
        out = addItem(out, parseDocument(out), c.add, c.item, today)
        const target = c.add === 'domains' ? ((expected.domains ??= { checked: today, list: [] }) as { list?: unknown[] }).list ??= [] : ((expected[c.add] ??= []) as unknown[])
        const at = field ? sortedIndex((target as Record<string, unknown>[]).map((x) => x?.[field]), c.item[field]) : -1
        if (at >= 0) target.splice(at, 0, structuredClone(c.item))
        else target.push(structuredClone(c.item))
        applied.push({ change: index, summary: describe(c, []) })
        continue
      }
      // meta: {…} is set: { 'meta.…': … }, from the top of the file.
      const target = 'update' in c ? listOf(expected, c.update)?.find((x) => x[COLLECTIONS[c.update]!] === c.id) : 'meta' in c ? (expected.meta as Record<string, unknown>) : expected
      if (!target) throw new Error('update' in c ? `${c.update} has no ${c.id}` : 'the file has no meta')
      const set = 'update' in c ? c.set : 'meta' in c ? c.meta : c.set
      const changed: string[] = []
      for (const [key, value] of Object.entries(set)) {
        const path = key.split('.')
        if (isDeepStrictEqual(getData(target, path), value)) continue
        if (!('update' in c) && !('meta' in c) && path[0] === 'domains' && !isObject(expected.domains)) throw new Error('the file has no domains section')
        const doc = parseDocument(out)
        const map = 'update' in c ? itemMap(doc, c.update, c.id) : 'meta' in c ? doc.get('meta', true) : doc.contents
        if (!isMap(map)) throw new Error(`could not find it in the file`)
        out = setIn(out, map, path, value)
        setData(target, path, value)
        changed.push(key)
      }
      if (changed.length) applied.push({ change: index, summary: describe(c, changed) })
    } catch (e) {
      out = before
      Object.assign(expected, beforeData)
      for (const k of Object.keys(expected)) if (!(k in beforeData)) delete expected[k]
      problems.push(`${describe(c, 'add' in c ? [] : Object.keys('update' in c ? c.set : 'meta' in c ? c.meta : c.set))}: ${(e as Error).message}`)
    }
  }

  let actual: unknown
  try {
    actual = parse(out)
  } catch (e) {
    throw new Error(`editing the file produced invalid YAML (${(e as Error).message}); nothing was written. Please report this.`)
  }
  if (!isDeepStrictEqual(actual, expected)) throw new Error('editing the file did not produce the intended data; nothing was written. Please report this.')
  return { text: out, applied, problems }
}

/** A unified diff of two texts, with `context` lines around each change. */
export function diffLines(a: string, b: string, context = 3) {
  const x = a.split('\n')
  const y = b.split('\n')
  let pre = 0
  while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++
  let suf = 0
  while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++
  const xs = x.slice(pre, x.length - suf)
  const ys = y.slice(pre, y.length - suf)
  // Longest common subsequence over the part that differs.
  const n = xs.length
  const m = ys.length
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = xs[i] === ys[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  const ops: { op: ' ' | '-' | '+'; line: string; a: number; b: number }[] = []
  for (let k = 0; k < pre; k++) ops.push({ op: ' ', line: x[k], a: k, b: k })
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && xs[i] === ys[j]) ops.push({ op: ' ', line: xs[i], a: pre + i++, b: pre + j++ })
    else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1])) ops.push({ op: '-', line: xs[i], a: pre + i++, b: pre + j })
    else ops.push({ op: '+', line: ys[j], a: pre + i, b: pre + j++ })
  }
  for (let k = 0; k < suf; k++) ops.push({ op: ' ', line: x[x.length - suf + k], a: x.length - suf + k, b: y.length - suf + k })

  const hunks: string[][] = []
  let k = 0
  while (k < ops.length) {
    if (ops[k].op === ' ') {
      k++
      continue
    }
    const start = Math.max(0, k - context)
    let end = k
    while (end < ops.length) {
      let next = end
      while (next < ops.length && ops[next].op !== ' ') next++
      let gap = next
      while (gap < ops.length && ops[gap].op === ' ') gap++
      if (gap < ops.length && gap - next <= context * 2) end = gap
      else {
        end = Math.min(ops.length, next + context)
        break
      }
    }
    const slice = ops.slice(start, end)
    const aLen = slice.filter((o) => o.op !== '+').length
    const bLen = slice.filter((o) => o.op !== '-').length
    hunks.push([`@@ -${slice[0].a + 1},${aLen} +${slice[0].b + 1},${bLen} @@`, ...slice.map((o) => `${o.op}${o.line}`)])
    k = end
  }
  return hunks.flat()
}
