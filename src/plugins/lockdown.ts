// Runs first inside the plugin process, before any plugin code. Node's permission model already
// stops file access, child processes and workers; this takes networking away from JavaScript, so
// the only way out is the `ctx` channel to Malha, which checks every call. Where the OS or Node
// also blocks the network this is a second layer; elsewhere it is the only one.

import { createRequire, syncBuiltinESMExports } from 'node:module'

const require = createRequire(import.meta.url)

function denied(what: string) {
  return function blocked(): never {
    const e = new Error(`${what} is not available to plugins. Use ctx.fetch (or fetch) for HTTP, declared in malha-plugin.json.`)
    ;(e as Error & { code: string }).code = 'MALHA_SANDBOX'
    throw e
  }
}

function strip(moduleName: string, names: string[]) {
  const mod = require(moduleName) as Record<string, unknown>
  for (const name of names) {
    if (typeof mod[name] === 'function') mod[name] = denied(`${moduleName}.${name}`)
  }
  return mod
}

const net = strip('node:net', ['connect', 'createConnection', 'createServer'])
for (const cls of ['Socket', 'Server'] as const) {
  const proto = (net[cls] as { prototype: Record<string, unknown> }).prototype
  for (const m of ['connect', 'listen']) if (typeof proto[m] === 'function') proto[m] = denied(`net.${cls}.${m}`)
}
strip('node:tls', ['connect', 'createServer'])
strip('node:http', ['request', 'get', 'createServer'])
strip('node:https', ['request', 'get', 'createServer'])
strip('node:http2', ['connect', 'createServer', 'createSecureServer'])
strip('node:dgram', ['createSocket'])
// DNS lookups can carry data out too.
const dns = require('node:dns') as Record<string, unknown> & { promises: Record<string, unknown>; Resolver: { prototype: Record<string, unknown> } }
for (const target of [dns, dns.promises, dns.Resolver.prototype, (dns.promises as { Resolver: { prototype: Record<string, unknown> } }).Resolver.prototype]) {
  for (const name of Object.keys(target)) if (typeof target[name] === 'function' && /^(lookup|resolve|reverse)/.test(name)) target[name] = denied(`dns.${name}`)
}
strip('node:child_process', ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])
syncBuiltinESMExports()

for (const name of ['WebSocket', 'EventSource', 'fetch'] as const) {
  Object.defineProperty(globalThis, name, { value: undefined, writable: true, configurable: true })
}

// Signals only to itself.
const kill = process.kill.bind(process)
process.kill = ((pid: number, signal?: string | number) => (pid === process.pid ? kill(pid, signal) : denied('process.kill')())) as typeof process.kill
