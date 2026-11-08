import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_FILE = 'topology.yaml'

/** The topology file from an argument, or ./topology.yaml. */
export const topologyPath = (arg?: string) => resolve(arg ?? DEFAULT_FILE)

/** Generated files (the scan) live in .malha/ next to the topology file. */
export const stateDir = (file: string) => join(dirname(file), '.malha')
export const scanPath = (file: string) => join(stateDir(file), 'scan.json')

/** The built viewer: dist/viewer next to dist/cli, or ../../dist/viewer when running from src. */
export function viewerDir() {
  for (const candidate of ['../viewer/', '../../dist/viewer/']) {
    const dir = fileURLToPath(new URL(candidate, import.meta.url))
    if (existsSync(join(dir, 'index.html'))) return dir
  }
  throw new Error('The viewer is not built. Run `npm run build` in the malha package.')
}

/** A path for messages: relative when inside the current folder, else from ~. */
export function display(path: string) {
  const rel = relative(process.cwd(), path)
  return rel && !rel.startsWith('..') ? rel : tildify(path)
}

export const tildify = (path: string) => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path)
export const untildify = (path: string) => (path.startsWith('~/') ? join(homedir(), path.slice(2)) : path)
