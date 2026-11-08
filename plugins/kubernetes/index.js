// Reads the cluster through kubectl (only `get` and `top`) and maps it onto the topology.
// It never writes: `import` returns proposed changes, which Malha shows as a diff.

const SYSTEM_NAMESPACES = new Set(['kube-system', 'kube-public', 'kube-node-lease', 'default'])
const TWO_LEVEL = /\.(com|net|org|gov|edu|co|ac|ne|or)\.[a-z]{2}$/

/** `kubectl` arguments, with --context when the project sets one. */
const kubectl = (ctx) => {
  const context = typeof ctx.options.context === 'string' ? ['--context', ctx.options.context] : []
  return async (...args) => {
    const r = await ctx.exec('kubectl', [...context, ...args])
    if (r.code !== 0) throw new Error(`kubectl ${args.slice(0, 2).join(' ')} failed: ${(r.stderr || r.stdout).trim().split('\n')[0]}`)
    return r.stdout
  }
}

/** A memory quantity in GiB: one decimal below 16 GiB, whole above. */
const gib = (quantity) => {
  const m = String(quantity).match(/^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|M|G|T)?$/)
  if (!m) return undefined
  const unit = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, K: 1e3, M: 1e6, G: 1e9, T: 1e12 }[m[2]] ?? 1
  const value = (Number(m[1]) * unit) / 2 ** 30
  return value < 16 ? Math.round(value * 10) / 10 : Math.round(value)
}

/** Capacity worth proposing: memory within 5% (rounding, reserved memory) counts as the same. */
const differs = (key, current, measured) =>
  current === undefined || (key === 'memory_gib' ? Math.abs(current - measured) / measured > 0.05 : current !== measured)

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** An app's namespaces: `namespace` is one name or a list. */
const spacesOf = (app) => (app.namespace === undefined ? [] : [app.namespace].flat())

/**
 * The app a namespace belongs to: one that lists it; else, among apps that name no namespace, one that
 * already lists a hostname the namespace serves, then one whose id is the namespace (ignoring punctuation).
 */
const appFinder = (apps, hostsByNamespace) => (ns) => {
  const unnamed = apps.filter((a) => !a.namespace)
  const hosts = hostsByNamespace.get(ns) ?? new Set()
  return (
    apps.find((a) => spacesOf(a).includes(ns)) ??
    unnamed.find((a) => (a.domains ?? []).some((d) => hosts.has(d))) ??
    unnamed.find((a) => a.id === ns) ??
    unnamed.find((a) => norm(a.id) === norm(ns))
  )
}

async function readNodes(run) {
  const items = JSON.parse(await run('get', 'nodes', '-o', 'json')).items ?? []
  return items.map((n) => {
    const labels = n.metadata.labels ?? {}
    const ready = (n.status.conditions ?? []).find((c) => c.type === 'Ready')?.status === 'True'
    const addresses = Object.fromEntries((n.status.addresses ?? []).map((a) => [a.type, a.address]))
    return {
      name: n.metadata.name,
      role: 'node-role.kubernetes.io/control-plane' in labels || 'node-role.kubernetes.io/master' in labels ? 'control-plane' : 'worker',
      ready,
      addresses,
      cpu: Number.parseInt(n.status.capacity?.cpu, 10) || undefined,
      memory_gib: gib(n.status.capacity?.memory),
      max_pods: Number.parseInt(n.status.capacity?.pods, 10) || undefined,
      kubelet: n.status.nodeInfo?.kubeletVersion,
      runtime: n.status.nodeInfo?.containerRuntimeVersion,
    }
  })
}

/** Pods that are not finished, as [node, namespace] pairs. */
async function readPods(run) {
  const out = await run('get', 'pods', '-A', '--field-selector=status.phase!=Succeeded,status.phase!=Failed', '-o', 'custom-columns=NODE:.spec.nodeName,NAMESPACE:.metadata.namespace', '--no-headers')
  return out
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length === 2 && p[0] !== '<none>')
}

/** CPU and memory percentages from kubectl top, or an empty map when metrics are unavailable. */
async function readTop(run) {
  try {
    const out = await run('top', 'nodes', '--no-headers')
    const usage = new Map()
    for (const line of out.split('\n')) {
      const cols = line.trim().split(/\s+/)
      const pct = cols.filter((c) => /^\d+%$/.test(c)).map((c) => Number.parseInt(c, 10))
      if (cols[0] && pct.length === 2) usage.set(cols[0], { cpu_pct: pct[0], memory_pct: pct[1] })
    }
    return { usage }
  } catch (e) {
    return { usage: new Map(), error: e.message }
  }
}

/** The topology node a cluster node is, matched by id, name, host or address. */
function matcher(topology) {
  const candidates = topology.nodes.filter((n) => n.kind === 'worker' || n.kind === 'control-plane' || n.kind === 'server')
  return (k) => {
    const ips = new Set(Object.values(k.addresses))
    return (
      candidates.find((n) => n.id === k.name) ??
      candidates.find((n) => n.name === k.name) ??
      candidates.find((n) => n.host && (n.host === k.name || n.host.startsWith(`${k.name}.`))) ??
      candidates.find((n) => Object.values(n.addresses ?? {}).some((a) => ips.has(a)))
    )
  }
}

const registered = (host) => {
  const h = host.replace(/^\*\./, '').toLowerCase()
  return h.split('.').slice(TWO_LEVEL.test(h) ? -3 : -2).join('.')
}

export default {
  commands: {
    async import(ctx) {
      const run = kubectl(ctx)
      const add = !ctx.args.includes('--no-add')
      const topology = await ctx.topology()
      const context = typeof ctx.options.context === 'string' ? ctx.options.context : (await ctx.exec('kubectl', ['config', 'current-context'])).stdout.trim()
      const [nodes, pods, top, ingresses] = await Promise.all([
        readNodes(run),
        readPods(run),
        readTop(run),
        run('get', 'ingress', '-A', '-o', 'json').then((o) => JSON.parse(o).items ?? []),
      ])
      const match = matcher(topology)
      const changes = []
      const notes = []
      const idOf = new Map()

      // Nodes: usage and capacity for the ones the file has, a draft entry for the rest.
      const zoneFor = (role) => topology.nodes.find((n) => n.kind === role)?.zone ?? topology.zones[0]?.id
      for (const k of nodes) {
        const podCount = pods.filter(([node]) => node === k.name).length
        const usage = { ...top.usage.get(k.name), pods: podCount, sampled: ctx.today }
        const n = match(k)
        if (n) {
          idOf.set(k.name, n.id)
          const set = {}
          for (const [key, value] of Object.entries(usage)) set[`usage.${key}`] = value
          for (const key of ['cpu', 'memory_gib', 'max_pods']) if (k[key] !== undefined && differs(key, n.hardware?.[key], k[key])) set[`hardware.${key}`] = k[key]
          if (!k.ready && n.status !== 'degraded') set.status = 'degraded'
          changes.push({ update: 'nodes', id: n.id, set, why: k.ready ? `${k.name} in the cluster` : `${k.name} is NotReady` })
        } else {
          idOf.set(k.name, k.name)
          if (!add) {
            notes.push(`not in the file: node ${k.name}`)
            continue
          }
          const addresses = {}
          if (k.addresses.ExternalIP) addresses.public = k.addresses.ExternalIP
          if (k.addresses.InternalIP) addresses.internal = k.addresses.InternalIP
          changes.push({
            add: 'nodes',
            item: {
              id: k.name,
              name: k.name,
              kind: k.role,
              zone: zoneFor(k.role),
              status: k.ready ? 'active' : 'degraded',
              ...(Object.keys(addresses).length ? { addresses } : {}),
              hardware: Object.fromEntries(['cpu', 'memory_gib', 'max_pods'].filter((key) => k[key] !== undefined).map((key) => [key, k[key]])),
              usage,
              notes: 'Drafted by malha kubernetes import. Check zone, provider and site.',
            },
            why: 'in the cluster, not in the file',
          })
        }
      }
      const clusterIds = new Set(idOf.values())
      for (const n of topology.nodes) {
        if ((n.kind === 'worker' || n.kind === 'control-plane') && n.status !== 'retired' && !clusterIds.has(n.id)) notes.push(`in the file, not in the cluster: ${n.id} (set status: retired if it is gone)`)
      }

      // Versions.
      const kubelet = nodes.find((n) => n.kubelet)?.kubelet
      const meta = {}
      if (kubelet && topology.meta.kubernetes && topology.meta.kubernetes.replace(/^v/, '') !== kubelet.replace(/^v/, ''))
        meta.kubernetes = topology.meta.kubernetes.startsWith('v') ? kubelet : kubelet.replace(/^v/, '')
      const runtime = nodes.find((n) => n.runtime)?.runtime?.replace('://', ' ')
      if (runtime && topology.meta.runtime && topology.meta.runtime !== runtime) meta.runtime = runtime

      // Apps: pod counts per node from their namespace, hostnames from its ingresses.
      const byNamespace = new Map()
      for (const [node, ns] of pods) {
        const counts = byNamespace.get(ns) ?? {}
        const id = idOf.get(node) ?? node
        counts[id] = (counts[id] ?? 0) + 1
        byNamespace.set(ns, counts)
      }
      const hostsByNamespace = new Map()
      for (const ing of ingresses) {
        const hosts = hostsByNamespace.get(ing.metadata.namespace) ?? new Set()
        for (const rule of ing.spec?.rules ?? []) if (rule.host) hosts.add(rule.host)
        hostsByNamespace.set(ing.metadata.namespace, hosts)
      }
      const apps = topology.apps ?? []
      const ignored = new Set([...SYSTEM_NAMESPACES, ...(Array.isArray(ctx.options.ignore_namespaces) ? ctx.options.ignore_namespaces : [])])
      const appFor = appFinder(apps, hostsByNamespace)
      const namespaces = new Set([...byNamespace.keys(), ...hostsByNamespace.keys()])
      const claimed = new Set()
      let podsChanged = false
      for (const app of apps) {
        const owned = [...namespaces].filter((ns) => appFor(ns) === app)
        if (!owned.length && !app.namespace) continue
        for (const ns of owned) claimed.add(ns)
        const set = {}
        // An app found by its hostnames or its id gets its namespace written down.
        if (!app.namespace && owned.length === 1 && owned[0] !== app.id) set.namespace = owned[0]
        const counts = {}
        for (const ns of owned) for (const [node, count] of Object.entries(byNamespace.get(ns) ?? {})) counts[node] = (counts[node] ?? 0) + count
        const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
        if (JSON.stringify(sorted) !== JSON.stringify(app.pods ?? {})) {
          set.pods = sorted
          podsChanged = true
        }
        const hosts = owned.flatMap((ns) => [...(hostsByNamespace.get(ns) ?? [])])
        const missing = [...new Set(hosts)].filter((h) => !(app.domains ?? []).includes(h))
        if (missing.length) set.domains = [...(app.domains ?? []), ...missing]
        if (Object.keys(set).length) changes.push({ update: 'apps', id: app.id, set, why: `namespace ${(owned.length ? owned : spacesOf(app)).join(', ')}` })
      }
      for (const [ns, counts] of byNamespace) {
        if (claimed.has(ns) || ignored.has(ns)) continue
        const total = Object.values(counts).reduce((a, b) => a + b, 0)
        if (!add) {
          notes.push(`not in the file: namespace ${ns} (${total} pods)`)
          continue
        }
        const hosts = [...(hostsByNamespace.get(ns) ?? [])]
        changes.push({
          add: 'apps',
          item: { id: ns, name: ns, category: 'internal', namespace: ns, ...(hosts.length ? { domains: hosts } : {}), pods: counts, notes: 'Drafted by malha kubernetes import. Set name and category.' },
          why: `namespace with ${total} pods that no app claims`,
        })
      }
      if (podsChanged) meta.pods_sampled = ctx.today
      if (Object.keys(meta).length) changes.push({ meta, why: 'from the cluster' })

      // Domains the ingresses use that the domain list lacks.
      if (add && topology.domains) {
        const known = new Set(topology.domains.list.map((d) => d.name))
        const wanted = new Set([...hostsByNamespace.values()].flatMap((s) => [...s]).map(registered))
        for (const name of [...wanted].sort()) if (!known.has(name)) changes.push({ add: 'domains', item: { name }, why: 'an ingress uses it' })
      }

      const total = pods.length
      const lines = [
        `Cluster ${context}: ${nodes.length} nodes, ${total} pods in ${byNamespace.size} namespaces, ${ingresses.length} ingresses.`,
        top.error ? `kubectl top failed, so CPU and memory are not refreshed: ${top.error}` : 'CPU and memory from kubectl top.',
        ...notes,
        ...(changes.some((c) => c.add === 'apps') ? ['Namespaces that are not apps (ingress-nginx, cert-manager…) can be skipped for good with options.ignore_namespaces in malha.plugins.json.'] : []),
      ]
      return { message: lines.join('\n'), changes }
    },
  },

  async live(ctx) {
    const run = kubectl(ctx)
    const [topology, nodes, pods, top] = await Promise.all([ctx.topology(), readNodes(run), readPods(run), readTop(run)])
    const match = matcher(topology)
    const out = {}
    for (const k of nodes) {
      const n = match(k)
      if (!n) continue
      out[n.id] = { ...top.usage.get(k.name), pods: pods.filter(([node]) => node === k.name).length, status: k.ready ? 'active' : 'degraded' }
    }
    return { nodes: out }
  },
}
