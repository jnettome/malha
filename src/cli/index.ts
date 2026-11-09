#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from './build.ts'
import { analytics } from './analytics.ts'
import { check } from './check.ts'
import { dev } from './dev.ts'
import { init, writeSchema } from './init.ts'
import { loadTopology } from './load.ts'
import { display, topologyPath, untildify } from './paths.ts'
import { scan } from './scan.ts'
import { addPlugin, allowPlugin, listPlugins, newPlugin, removePlugin, revokePlugin, runCommand, showLog } from '../plugins/commands.ts'
import { readProject } from '../plugins/project.ts'

const VERSION = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version

const HELP = `malha ${VERSION}: your infrastructure as one YAML file, drawn as a live map.

Usage
  malha init [dir]            starter topology.yaml, schema and .gitignore   --example  --force
  malha dev [file]            open the viewer; the page reloads when the file changes, live plugins refresh it
                                --port 5199  --host 127.0.0.1  --no-plugins
  malha validate [file]       schema, references and standards; exit 1 on errors   --strict
  malha build [file]          static site with the data inside   --out malha-site  --no-scan  --no-analytics
  malha scan [file]           known vulnerabilities in every app's dependencies
                                --code-dir <dir> (or $MALHA_CODE_DIR)  --app <id>  --no-fetch  --offline
  malha check [file]          what needs a person: expiring domains, full nodes, single-node databases, vulnerabilities
                                --live  --notify  --digest  --json  --fail-on critical|warning|none  --vulns critical|high|medium
  malha analytics [file]      traffic per app from Umami, Google Analytics, PostHog and Search Console
  malha analytics refresh [file]   fetch the last 7, 30 and 90 days   --days N  --from YYYY-MM-DD --to YYYY-MM-DD  --timezone UTC
  malha analytics detect [file]    find the trackers on each app's pages; propose its analytics sources   --dry-run  --yes
  malha schema [dir]          write topology.schema.json for editor autocomplete

Plugins (listed in malha.plugins.json next to the file; see docs/plugins.md)
  malha <plugin> <command> [file]   run a plugin's command; you review its changes as a diff
                                      --dry-run  --yes (write without asking)  -- <plugin args>
  malha plugin add <name|dir> [file]  review a plugin and add it to the project   --yes
  malha plugin list [file]            plugins, what they may do, and your approvals
  malha plugin allow <name> [file]    approve everything it declares, for scripts and CI   --yes
  malha plugin revoke <name> [file]   forget your approvals
  malha plugin remove <name> [file]   take it out of the project
  malha plugin log [file]             what plugins asked for and what was decided   --plugin <name>
  malha plugin new <dir>              start a new plugin   --name <name>

[file] defaults to ./topology.yaml.`

interface Parsed {
  positionals: string[]
  flags: Map<string, string[]>
}

/** --name value, --name=value, --switch. Flags listed in `switches` take no value. */
function parse(argv: string[], switches: string[]): Parsed {
  const positionals: string[] = []
  const flags = new Map<string, string[]>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      positionals.push(a)
      continue
    }
    const [name, inline] = a.slice(2).split(/=(.*)/s, 2)
    const value = switches.includes(name) ? 'true' : (inline ?? argv[++i])
    if (value === undefined) throw new Error(`--${name} needs a value`)
    flags.set(name, [...(flags.get(name) ?? []), value])
  }
  return { positionals, flags }
}

const one = (p: Parsed, name: string) => p.flags.get(name)?.at(-1)
const has = (p: Parsed, name: string) => p.flags.has(name)

function checkFlags(p: Parsed, allowed: string[]) {
  for (const name of p.flags.keys()) if (!allowed.includes(name)) throw new Error(`unknown option --${name}`)
}

/** Split off everything after `--`, which belongs to a plugin. */
function passthrough(argv: string[]) {
  const i = argv.indexOf('--')
  return i === -1 ? { own: argv, extra: [] } : { own: argv.slice(0, i), extra: argv.slice(i + 1) }
}

async function plugin(sub: string | undefined, rest: string[]) {
  const p = parse(rest, ['yes'])
  const [first, second] = p.positionals
  switch (sub) {
    case 'add':
      checkFlags(p, ['yes'])
      if (!first) throw new Error('usage: malha plugin add <name|dir> [file]')
      return addPlugin(topologyPath(second), first, { yes: has(p, 'yes') })
    case 'list':
      checkFlags(p, [])
      return listPlugins(topologyPath(first))
    case 'allow':
    case 'revoke':
    case 'remove':
      checkFlags(p, sub === 'allow' ? ['yes'] : [])
      if (!first) throw new Error(`usage: malha plugin ${sub} <name> [file]`)
      if (sub === 'allow') return allowPlugin(topologyPath(second), first, { yes: has(p, 'yes') })
      return sub === 'revoke' ? revokePlugin(topologyPath(second), first) : removePlugin(topologyPath(second), first)
    case 'log':
      checkFlags(p, ['plugin'])
      return showLog(topologyPath(first), one(p, 'plugin'))
    case 'new':
      checkFlags(p, ['name'])
      if (!first) throw new Error('usage: malha plugin new <dir> [--name <name>]')
      return newPlugin(resolve(first), one(p, 'name'))
    case 'run': {
      const { own, extra } = passthrough(rest)
      const q = parse(own, ['yes', 'dry-run'])
      checkFlags(q, ['yes', 'dry-run'])
      const [name, command, file] = q.positionals
      if (!name) throw new Error('usage: malha plugin run <plugin> <command> [file]')
      return runCommand(topologyPath(file), name, command, { args: extra, yes: has(q, 'yes'), dryRun: has(q, 'dry-run') })
    }
    default:
      throw new Error('usage: malha plugin add|list|allow|revoke|remove|log|new … (malha --help)')
  }
}

async function main(argv: string[]) {
  const [command, ...rest] = argv
  if (!command || command === 'help' || command === '--help' || command === '-h') return console.log(HELP)
  if (command === '--version' || command === '-v') return console.log(VERSION)

  switch (command) {
    case 'init': {
      const p = parse(rest, ['example', 'force'])
      checkFlags(p, ['example', 'force'])
      return init(resolve(p.positionals[0] ?? '.'), { example: has(p, 'example'), force: has(p, 'force') })
    }
    case 'dev': {
      const p = parse(rest, ['no-plugins'])
      checkFlags(p, ['port', 'host', 'no-plugins'])
      return dev(topologyPath(p.positionals[0]), { port: Number(one(p, 'port') ?? 5199), host: one(p, 'host') ?? '127.0.0.1', plugins: !has(p, 'no-plugins') })
    }
    case 'validate': {
      const p = parse(rest, ['strict'])
      checkFlags(p, ['strict'])
      const file = topologyPath(p.positionals[0])
      const { data, errors, warnings } = loadTopology(file)
      for (const w of warnings) console.warn(`warn  ${w}`)
      for (const e of errors) console.error(`error ${e}`)
      const name = display(file)
      if (errors.length || !data) {
        console.error(`\n${name}: ${errors.length} error(s), ${warnings.length} warning(s)`)
        process.exitCode = 1
        return
      }
      const pods = data.nodes.reduce((sum, n) => sum + (n.usage?.pods ?? 0), 0)
      console.log(
        `${name}: ok · ${data.nodes.length} nodes, ${data.links?.length ?? 0} links, ${data.apps?.length ?? 0} apps, ` +
          `${data.domains?.list.length ?? 0} domains, ${data.flows?.length ?? 0} flows, ${pods} pods · ${warnings.length} warning(s)`,
      )
      if (has(p, 'strict') && warnings.length) process.exitCode = 1
      return
    }
    case 'build': {
      const p = parse(rest, ['no-scan', 'no-analytics'])
      checkFlags(p, ['out', 'no-scan', 'no-analytics'])
      return build(topologyPath(p.positionals[0]), resolve(one(p, 'out') ?? 'malha-site'), { scan: !has(p, 'no-scan'), analytics: !has(p, 'no-analytics') })
    }
    case 'scan': {
      const p = parse(rest, ['no-fetch', 'offline'])
      checkFlags(p, ['code-dir', 'app', 'no-fetch', 'offline'])
      const codeDir = one(p, 'code-dir') ?? process.env.MALHA_CODE_DIR
      if (!codeDir) throw new Error('Where are the clones? Pass --code-dir <dir> or set MALHA_CODE_DIR.')
      return scan(topologyPath(p.positionals[0]), {
        codeDir: resolve(untildify(codeDir)),
        apps: p.flags.get('app') ?? [],
        fetch: !has(p, 'no-fetch'),
        offline: has(p, 'offline'),
      })
    }
    case 'domains':
      // Replaced by plugins in 0.4.0.
      throw new Error(
        'malha domains sync became the porkbun and cloudflare plugins:\n' +
          '  malha plugin add porkbun [file] && malha porkbun sync [file]\n' +
          '  malha plugin add cloudflare [file] && malha cloudflare zones [file]\n' +
          'They take the same credentials. See docs/plugins.md.',
      )
    case 'analytics': {
      const sub = ['show', 'refresh', 'detect'].includes(rest[0]) ? rest[0] : undefined
      const p = parse(sub ? rest.slice(1) : rest, ['yes', 'dry-run'])
      checkFlags(p, ['days', 'from', 'to', 'timezone', 'yes', 'dry-run'])
      const days = one(p, 'days') === undefined ? undefined : Number(one(p, 'days'))
      if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 365)) throw new Error('--days takes a whole number from 1 to 365')
      return analytics(topologyPath(p.positionals[0]), sub, { days, from: one(p, 'from'), to: one(p, 'to'), timezone: one(p, 'timezone') ?? Intl.DateTimeFormat().resolvedOptions().timeZone, yes: has(p, 'yes'), dryRun: has(p, 'dry-run') })
    }
    case 'check': {
      const p = parse(rest, ['live', 'notify', 'digest', 'json'])
      checkFlags(p, ['live', 'notify', 'digest', 'json', 'fail-on', 'vulns'])
      const failOn = one(p, 'fail-on') ?? 'critical'
      const vulns = one(p, 'vulns') ?? 'critical'
      if (!['critical', 'warning', 'none'].includes(failOn)) throw new Error('--fail-on takes critical, warning or none')
      if (!['critical', 'high', 'medium', 'low'].includes(vulns)) throw new Error('--vulns takes critical, high, medium or low')
      return check(topologyPath(p.positionals[0]), {
        live: has(p, 'live'),
        notify: has(p, 'notify'),
        digest: has(p, 'digest'),
        json: has(p, 'json'),
        failOn: failOn as 'critical' | 'warning' | 'none',
        vulns: vulns as 'critical' | 'high' | 'medium' | 'low',
      })
    }
    case 'schema': {
      const p = parse(rest, [])
      checkFlags(p, [])
      const target = writeSchema(resolve(p.positionals[0] ?? '.'))
      return console.log(`Wrote ${display(target)}`)
    }
    case 'plugin':
    case 'plugins':
      return plugin(rest[0], rest.slice(1))
    default: {
      // `malha <plugin> <command> [file]`, for plugins listed next to the file.
      const { own, extra } = passthrough(rest)
      const p = parse(own, ['yes', 'dry-run'])
      const file = topologyPath(p.positionals[1])
      let listed = false
      try {
        listed = command in readProject(file).plugins
      } catch {
        // an unreadable malha.plugins.json is reported when a plugin command runs
      }
      if (!listed) throw new Error(`unknown command "${command}". Run malha --help, or malha plugin list for plugins.`)
      checkFlags(p, ['yes', 'dry-run'])
      return runCommand(file, command, p.positionals[0], { args: extra, yes: has(p, 'yes'), dryRun: has(p, 'dry-run') })
    }
  }
}

main(process.argv.slice(2)).catch((e) => {
  console.error(`malha: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
