import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// How plugin code is contained. Always: a separate Node process under Node's permission model,
// able to read only its own folder and Malha's plugin runtime, with no child processes, workers,
// native addons or environment. The network is cut by the strongest layer this machine has:
//   - an OS sandbox (bubblewrap or unshare on Linux, sandbox-exec on macOS), each proven by a
//     self-test before it is used;
//   - Node's own network permission (Node 25 and later);
//   - always, a JavaScript lockdown of the networking modules, which alone is best effort.

export interface Isolation {
  /** Wrapper argv put before `node`. */
  wrap: string[]
  /** What cuts the network, in words. */
  network: string
  /** True when something below JavaScript blocks the network. */
  strong: boolean
}

const MAC_PROFILE = '(version 1)(allow default)(deny network-outbound (remote ip))(deny network-inbound (local ip))(deny network-bind (local ip))'

export function which(name: string) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const full = join(dir, name)
    try {
      accessSync(full, constants.X_OK)
      return full
    } catch {
      // keep looking
    }
  }
  return undefined
}

function candidates(): { wrap: string[]; network: string }[] {
  if (process.platform === 'darwin')
    return existsSync('/usr/bin/sandbox-exec') ? [{ wrap: ['/usr/bin/sandbox-exec', '-p', MAC_PROFILE], network: 'macOS sandbox' }] : []
  if (process.platform !== 'linux') return []
  const out: { wrap: string[]; network: string }[] = []
  const bwrap = which('bwrap')
  if (bwrap) {
    // Own network and process namespaces: no network, and it cannot signal the user's processes.
    out.push({ wrap: [bwrap, '--dev-bind', '/', '/', '--unshare-net', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--new-session', '--'], network: 'bubblewrap (Linux namespaces)' })
  }
  const unshare = which('unshare')
  if (unshare) {
    out.push({ wrap: [unshare, '--net', '--map-current-user', '--'], network: 'unshare (Linux network namespace)' })
    out.push({ wrap: [unshare, '-rn', '--'], network: 'unshare (Linux network namespace)' })
  }
  return out
}

/** True when the wrapped process starts, talks over IPC, and cannot reach a port on this machine. */
async function selfTest(wrap: string[]): Promise<boolean> {
  const server = createServer((s) => s.end()).listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const { port } = server.address() as AddressInfo
  const probe = `const s=require('net').connect(${port},'127.0.0.1');s.on('connect',()=>process.send('reached'));s.on('error',()=>process.send('blocked'));process.on('message',()=>process.exit(0))`
  try {
    return await new Promise<boolean>((resolve) => {
      const child = spawn(wrap[0], [...wrap.slice(1), process.execPath, '-e', probe], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: {} })
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve(false)
      }, 5000)
      child.on('error', () => resolve(false))
      child.on('message', (m) => {
        clearTimeout(timer)
        child.send('bye')
        resolve(m === 'blocked')
      })
      child.on('exit', () => {
        clearTimeout(timer)
        resolve(false)
      })
    })
  } finally {
    server.close()
  }
}

const nodeBlocksNetwork = () => process.allowedNodeEnvironmentFlags.has('--allow-net')

let detected: Promise<Isolation> | undefined

/** The isolation this machine supports. Tested once per process. */
export function isolation(): Promise<Isolation> {
  detected ??= (async () => {
    const node = nodeBlocksNetwork()
    for (const c of candidates()) {
      if (await selfTest(c.wrap)) return { wrap: c.wrap, network: node ? `${c.network} and Node's permission model` : c.network, strong: true }
    }
    if (node) return { wrap: [], network: "Node's permission model", strong: true }
    return { wrap: [], network: 'JavaScript lockdown only (install bubblewrap, or use Node 25+, for a hard block)', strong: false }
  })()
  return detected
}

/** `MALHA_PLUGIN_SANDBOX=strict` refuses to run plugins without a network block below JavaScript. */
export async function requireIsolation() {
  const iso = await isolation()
  if (process.env.MALHA_PLUGIN_SANDBOX === 'strict' && !iso.strong)
    throw new Error(`MALHA_PLUGIN_SANDBOX=strict, but this machine can only block the network in JavaScript. Install bubblewrap (Linux) or use Node 25 or later.`)
  return iso
}

/** The runtime that loads a plugin inside the sandbox: runtime.js in dist, runtime.ts from source. */
export function runtimeFile() {
  const self = fileURLToPath(import.meta.url)
  return join(dirname(self), self.endsWith('.ts') ? 'runtime.ts' : 'runtime.js')
}

/** argv for one sandboxed plugin process. */
export function sandboxArgv(iso: Isolation, pluginDir: string) {
  const runtime = runtimeFile()
  const permission = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : '--experimental-permission'
  return [
    ...iso.wrap,
    process.execPath,
    permission,
    `--allow-fs-read=${dirname(runtime)}`,
    `--allow-fs-read=${pluginDir}`,
    '--max-old-space-size=512',
    '--no-warnings',
    runtime,
  ]
}
