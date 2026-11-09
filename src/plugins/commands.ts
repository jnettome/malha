import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkTopology, loadTopology } from '../cli/load.ts'
import { display, stateDir } from '../cli/paths.ts'
import { applyChanges, checkChanges, diffLines } from './edit.ts'
import { runPlugin, Session, today } from './host.ts'
import { RESERVED, shortHash } from './manifest.ts'
import { inspect, isPath, loadPlugin, loadPlugins, locate, PROJECT_FILE, projectPath, readProject, writeProject, type Resolved } from './project.ts'
import { execWarning, ruleKey, type Kind } from './rules.ts'
import { isolation } from './sandbox.ts'
import type { CommandResult, Manifest } from './sdk.ts'
import { allowAlways, allowedRules, audit, revoke } from './state.ts'
import { askLine, c, choose, interactive, parseSelection, pluginLine, printDiff, terminalAsker } from './terminal.ts'

const TEMPLATE = fileURLToPath(new URL('../../templates/plugin/', import.meta.url))
const LABEL: Record<Kind, string> = { exec: 'run', fetch: 'fetch', files: 'read', env: 'env' }

const rules = (m: Manifest) => (['exec', 'fetch', 'files', 'env'] as Kind[]).flatMap((kind) => (m.permissions[kind] ?? []).map((pattern) => ({ kind, pattern })))

/** What a plugin can do, for review before it is added or allowed. */
async function review(manifest: Manifest, origin: string, integrity: string, files: number) {
  const iso = await isolation()
  const out = [`${c.bold(`${manifest.name} ${manifest.version}`)} ${c.dim(`· ${origin}`)}`, manifest.description, '']
  const list = rules(manifest)
  if (list.length) {
    out.push('Each time it wants to, it can ask you to let it:')
    for (const r of list) {
      const warn = r.kind === 'exec' ? execWarning(r.pattern) : undefined
      const fromOptions = /\{options\.([A-Za-z0-9_]+)\}/.exec(r.pattern)
      out.push(`  ${LABEL[r.kind].padEnd(6)} ${r.pattern}${warn ? `  ${c.yellow(`⚠ ${warn}`)}` : ''}${fromOptions ? c.dim(`  (the host comes from options.${fromOptions[1]} in malha.plugins.json)`) : ''}`)
    }
  } else out.push('It asks for no programs, URLs, files or environment variables.')
  const also: string[] = []
  if (manifest.permissions.topology === 'read') also.push('read the topology')
  if (manifest.permissions.topology === 'propose') also.push('read the topology and propose changes, which you review as a diff before anything is written')
  if (manifest.live) also.push(`show live data while malha dev runs, every ${manifest.live.every} s${manifest.live.description ? `: ${manifest.live.description}` : ''}`)
  if (manifest.notify) also.push(`receive what malha check --notify announces${manifest.notify.description ? `: ${manifest.notify.description}` : ''}`)
  if (also.length) out.push('', 'Without asking, it can:', ...also.map((a) => `  ${a}`))
  const commands = Object.entries(manifest.commands ?? {})
  if (commands.length) out.push('', 'Commands:', ...commands.map(([name, text]) => `  malha ${manifest.name} ${name}  ${c.dim(text)}`))
  out.push('', c.dim(`Code: ${files} file(s), sha256 ${shortHash(integrity)}`), c.dim(`Sandbox: it can read only its own folder; network blocked by ${iso.network}`))
  if (!iso.strong) out.push(c.yellow('The network block here is JavaScript only. Install bubblewrap, or use Node 25 or later, for a hard block.'))
  return out
}

const say = (lines: string[]) => console.log(lines.map((l) => (l ? `  ${l}` : '')).join('\n'))

export async function addPlugin(file: string, source: string, opts: { yes: boolean }) {
  const base = dirname(file)
  // A folder you type is relative to where you are; malha.plugins.json stores it relative to itself.
  const where = locate(isPath(source) ? resolve(source) : source, base)
  const { manifest, integrity, files } = inspect(where.dir)
  const project = readProject(file)
  const existing = project.plugins[manifest.name]
  if (existing && locate(existing.source, base).dir !== where.dir) throw new Error(`${PROJECT_FILE} already has a different plugin called "${manifest.name}" (${existing.source})`)
  say(['', ...(await review(manifest, where.builtin ? 'ships with Malha' : where.source, integrity, files))])
  if (!where.builtin) say(['', c.yellow('This code is not part of Malha. Read it before adding it:'), `  ${where.dir}`])
  if ('outside' in where && where.outside) say(['', c.yellow('It lives far outside this project, so teammates will not have it. Put plugins inside the repo to share them.')])
  if (!opts.yes) {
    if (!interactive()) throw new Error('adding a plugin needs a yes: run this in a terminal, or pass --yes after reviewing it')
    const pick = await choose([`Add ${manifest.name} to ${display(projectPath(file))}?`], ['Yes', 'No'])
    if (pick !== 0) return console.log('  Nothing changed.')
  }
  project.plugins[manifest.name] = { ...existing, source: where.source, ...(where.builtin ? { integrity: undefined } : { integrity }) }
  writeProject(file, project)
  const first = Object.keys(manifest.commands ?? {})[0]
  console.log(`\n  Added ${manifest.name} to ${display(projectPath(file))}. Commit that file so the team gets it; each person approves what it does on their own machine.`)
  if (first) console.log(`  Try: malha ${manifest.name} ${first} ${display(file)}`)
  if (manifest.live) console.log(`  Its live data appears in malha dev ${display(file)}.`)
  if (manifest.notify) console.log(`  It receives what malha check ${display(file)} --notify announces.`)
}

export async function listPlugins(file: string) {
  const all = loadPlugins(file)
  if (!all.length) return console.log(`No plugins in ${display(projectPath(file))}. Add one with: malha plugin add <name or folder>`)
  const iso = await isolation()
  for (const p of all) {
    if (!p.plugin) {
      console.log(`${c.red('✗')} ${c.bold(p.name)}  ${p.error}`)
      continue
    }
    const r = p.plugin
    const allowed = Object.keys(allowedRules(file, r.name, r.integrity)).length
    const total = rules(r.manifest).length
    const live = r.manifest.live ? (r.entry.live === false ? 'live off' : `live every ${r.manifest.live.every} s`) : r.manifest.notify ? (r.entry.notify === false ? 'notifier off' : 'notifier') : ''
    console.log(`${c.green('✓')} ${c.bold(r.name)} ${r.manifest.version}  ${c.dim(r.builtin ? 'ships with Malha' : r.entry.source)}`)
    console.log(`    ${r.manifest.description}`)
    console.log(`    ${[`commands: ${Object.keys(r.manifest.commands ?? {}).join(', ') || 'none'}`, live, `you allowed ${allowed} of ${total} permission(s) always`].filter(Boolean).join(' · ')}`)
    for (const w of r.warnings) console.log(`    ${c.yellow(w)}`)
  }
  console.log(c.dim(`\nNetwork for plugins blocked by ${iso.network}.`))
}

/** Run `malha <plugin> <command>`, then review and maybe write what it proposes. */
export async function runCommand(file: string, name: string, command: string | undefined, opts: { args: string[]; yes: boolean; dryRun: boolean }) {
  const plugin = loadPlugin(file, name)
  const commands = Object.keys(plugin.manifest.commands ?? {})
  if (!command || !commands.includes(command))
    throw new Error(`${command ? `${name} has no command "${command}". ` : ''}Commands: ${commands.map((c) => `malha ${name} ${c}`).join(', ') || 'none'}`)
  const { data, errors } = loadTopology(file)
  if (!data) throw new Error(`${display(file)} is invalid; fix it first:\n  ${errors.join('\n  ')}`)
  const result = (await runPlugin({ file, plugin, run: { kind: 'command', name: command }, args: opts.args, asker: terminalAsker(), session: new Session(), output: pluginLine(name) })) as CommandResult
  if (typeof result.message === 'string' && result.message) console.log(`\n${result.message.split('\n').map((l) => `  ${l}`).join('\n')}`)
  await reviewChanges(file, plugin, result.changes, opts)
}

async function reviewChanges(file: string, plugin: Resolved, raw: unknown, opts: { yes: boolean; dryRun: boolean }) {
  if (raw === undefined || (Array.isArray(raw) && !raw.length)) return
  if (plugin.manifest.permissions.topology !== 'propose') throw new Error(`${plugin.name} returned changes, but its manifest does not declare "topology": "propose"; ignored`)
  return proposeChanges(file, plugin.name, raw, opts)
}

/** Check changes, show them as a diff, and write them on a yes. `by` names who proposes them. */
export async function proposeChanges(file: string, by: string, raw: unknown, opts: { yes: boolean; dryRun: boolean }) {
  const { ok, problems } = checkChanges(raw)
  const original = readFileSync(file, 'utf8')
  const date = today()
  let proposal = applyChanges(original, ok, date)
  problems.push(...proposal.problems)
  if (problems.length) say(['', c.yellow(`Skipped ${problems.length} change(s):`), ...problems.map((p) => `  ${p}`)])
  if (!proposal.applied.length) return console.log(`\n  ${by} proposes no changes to ${display(file)}; it is up to date.`)

  for (;;) {
    const lines = diffLines(original, proposal.text)
    say(['', `${c.bold(by)} proposes ${proposal.applied.length} change(s) to ${display(file)}:`, ...proposal.applied.map((a, i) => `  ${c.cyan(`${i + 1}.`)} ${a.summary}`), ''])
    printDiff(lines)
    const check = checkTopology(proposal.text)
    if (check.errors.length) {
      say(['', c.red('With these changes the file would be invalid, so nothing was written:'), ...check.errors.map((e) => `  ${e}`)])
      process.exitCode = 1
      return
    }
    if (opts.dryRun) return console.log(`\n  Dry run: nothing written.`)
    let pick = 0
    if (!opts.yes) {
      if (!interactive()) throw new Error('writing changes needs a yes: run this in a terminal, or pass --yes (or --dry-run to only see them)')
      pick = await choose([`Write these changes to ${display(file)}?`], ['Yes', 'No', 'Choose which'])
    }
    if (pick === 1) {
      audit(file, { plugin: by, kind: 'write', detail: proposal.applied.map((a) => a.summary).join('; '), decision: 'declined' })
      return console.log('  Nothing written.')
    }
    if (pick === 2) {
      const input = await askLine(`Which? Numbers like 1,3-5 ${c.dim('(from the list above)')} ›`)
      const picked = parseSelection(input, proposal.applied.length)
      if (!picked?.length) {
        console.log('  Nothing chosen; nothing written.')
        return
      }
      const kept = new Set(picked.map((i) => proposal.applied[i].change))
      proposal = applyChanges(original, ok.filter((_, i) => kept.has(i)), date)
      continue
    }
    if (readFileSync(file, 'utf8') !== original) throw new Error(`${display(file)} changed while you were reviewing; nothing written. Run the command again.`)
    writeFileSync(file, proposal.text)
    audit(file, { plugin: by, kind: 'write', detail: proposal.applied.map((a) => a.summary).join('; '), decision: 'wrote' })
    return console.log(`\n  Wrote ${proposal.applied.length} change(s) to ${display(file)}. Review with git diff, then commit.`)
  }
}

export async function allowPlugin(file: string, name: string, opts: { yes: boolean }) {
  const plugin = loadPlugin(file, name)
  say(['', ...(await review(plugin.manifest, plugin.builtin ? 'ships with Malha' : plugin.entry.source, plugin.integrity, plugin.files)), ...plugin.warnings.map((w) => c.yellow(w))])
  const keys = rules(plugin.manifest).map(ruleKey)
  if (!keys.length) return console.log(`\n  ${name} asks for nothing that needs approval.`)
  if (!opts.yes) {
    if (!interactive()) throw new Error('approving needs a yes: run this in a terminal, or pass --yes after reviewing it')
    const pick = await choose([`Allow all ${keys.length} permission(s) above, always, for this version of ${name}?`], ['Yes', 'No'])
    if (pick !== 0) return console.log('  Nothing changed.')
  }
  allowAlways(file, name, plugin.integrity, keys)
  console.log(`\n  ${name} can now do the above without asking, until its code changes. Undo with: malha plugin revoke ${name}`)
}

export function revokePlugin(file: string, name: string) {
  console.log(revoke(file, name) ? `Forgot your approvals for ${name}; it asks again next time.` : `You had no saved approvals for ${name}.`)
}

export function removePlugin(file: string, name: string) {
  const project = readProject(file)
  if (!project.plugins[name]) throw new Error(`"${name}" is not in ${PROJECT_FILE}`)
  delete project.plugins[name]
  writeProject(file, project)
  revoke(file, name)
  console.log(`Removed ${name} from ${display(projectPath(file))}. Its folder, if it has one, is untouched.`)
}

export function newPlugin(dir: string, name = basename(dir)) {
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(name)) throw new Error(`"${name}" is not a plugin name: lowercase letters, digits and dashes. Pass --name.`)
  if (RESERVED.has(name)) throw new Error(`"${name}" is one of Malha's own commands; pick another name`)
  if (existsSync(join(dir, 'malha-plugin.json'))) throw new Error(`${display(dir)} already has a malha-plugin.json`)
  mkdirSync(dir, { recursive: true })
  for (const f of ['malha-plugin.json', 'index.js', 'package.json', 'README.md']) {
    writeFileSync(join(dir, f), readFileSync(join(TEMPLATE, f), 'utf8').replaceAll('{{name}}', name))
  }
  console.log(`Wrote a plugin in ${display(dir)}/. Next:
  1. Edit malha-plugin.json: what it may run, fetch and read.
  2. Write index.js.
  3. In your project: malha plugin add ${display(dir)}   (re-run after every change to the code)
  4. Then: malha ${name} hello`)
}

export function showLog(file: string, name?: string) {
  const path = join(stateDir(file), 'plugins.log')
  if (!existsSync(path)) return console.log('No plugin activity yet.')
  const entries = readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { at: string; plugin: string; kind: string; detail: string; decision: string })
    .filter((e) => !name || e.plugin === name)
    .slice(-50)
  for (const e of entries) console.log(`${c.dim(e.at.replace('T', ' ').slice(0, 19))}  ${e.plugin.padEnd(14)} ${e.decision.padEnd(13)} ${e.kind.padEnd(6)} ${e.detail}`)
}
