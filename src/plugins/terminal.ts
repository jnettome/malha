import { createInterface } from 'node:readline/promises'
import type { Answer, Asker, Question } from './host.ts'

// Questions in the terminal, numbered like Claude Code's. Plugin output is held back while a
// question is on screen, so it cannot be mistaken for, or bury, the question.

const color = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s)
export const c = { bold: paint('1'), dim: paint('2'), red: paint('31'), green: paint('32'), yellow: paint('33'), cyan: paint('36') }

export const interactive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY)

let held: string[] | undefined

/** Print a plugin's output line, or keep it until the open question is answered. */
export const pluginLine = (name: string) => (line: string) => {
  const out = `  ${c.dim(`${name} │`)} ${line}`
  if (held) held.push(out)
  else console.log(out)
}

/** Ask with numbered options; returns the index chosen. */
export async function choose(lines: string[], options: string[]): Promise<number> {
  held ??= []
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    console.log(`\n${lines.map((l) => `  ${l}`).join('\n')}\n`)
    console.log(options.map((o, i) => `  ${c.cyan(`${i + 1}.`)} ${o}`).join('\n'))
    for (;;) {
      const answer = (await rl.question(`\n  ${c.cyan('›')} `)).trim()
      const n = Number(answer)
      if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1
      console.log(`  Type a number from 1 to ${options.length}.`)
    }
  } finally {
    rl.close()
    const pending = held ?? []
    held = undefined
    for (const line of pending) console.log(line)
  }
}

export const VERB: Record<Question['kind'], string> = {
  exec: 'run a program',
  fetch: 'make a web request',
  files: 'read a file',
  env: 'read an environment variable',
}

/** Asks in the terminal; without one, says no and explains how to allow ahead of time. */
export function terminalAsker(): Asker {
  let told = false
  return {
    async ask(q) {
      if (!interactive()) {
        if (!told) console.error(`${q.plugin} needs approval that only a terminal can give. Run it once in a terminal, or approve ahead of time with: malha plugin allow ${q.plugin}`)
        told = true
        return 'deny'
      }
      const lines = [
        `${c.bold(q.plugin)} wants to ${VERB[q.kind]}`,
        `  ${c.yellow(q.detail)}`,
        c.dim(`Declared in its manifest as: ${q.rule}`),
      ]
      const pick = await choose(lines, ['Yes', `Yes, and don't ask again for ${c.bold(q.rule)} ${c.dim(`(${q.plugin} ${q.version}, ${q.hash})`)}`, 'No'])
      return (['once', 'always', 'deny'] as Answer[])[pick]
    },
  }
}

export function printDiff(lines: string[]) {
  for (const line of lines) {
    const out = line.startsWith('@@') ? c.cyan(line) : line.startsWith('+') ? c.green(line) : line.startsWith('-') ? c.red(line) : c.dim(line)
    console.log(`  ${out}`)
  }
}

/** "1,3-5" → [0, 2, 3, 4] within 1..max. */
export function parseSelection(input: string, max: number) {
  const picked = new Set<number>()
  for (const part of input.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/)
    if (!m) return undefined
    const from = Number(m[1])
    const to = Number(m[2] ?? m[1])
    if (from < 1 || to > max || from > to) return undefined
    for (let i = from; i <= to; i++) picked.add(i - 1)
  }
  return [...picked].sort((a, b) => a - b)
}

export async function askLine(prompt: string) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question(`  ${prompt} `)).trim()
  } finally {
    rl.close()
  }
}
