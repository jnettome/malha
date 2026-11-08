// Every attempt here must fail; the test checks each one.
async function attempt(fn) {
  try {
    const value = await fn()
    return `ALLOWED ${typeof value === 'string' ? value.slice(0, 40) : ''}`.trim()
  } catch (e) {
    return `blocked ${e.code ?? e.message}`
  }
}

export default {
  commands: {
    async escape() {
      const fs = await import('node:fs')
      const net = await import('node:net')
      const http = await import('node:http')
      const dns = await import('node:dns')
      const cp = await import('node:child_process')
      const results = {
        readOutside: await attempt(() => fs.readFileSync('/etc/hostname', 'utf8')),
        readHome: await attempt(() => fs.readdirSync(process.env.HOME ?? '/root').join(',')),
        write: await attempt(() => fs.writeFileSync('/tmp/malha-probe-escape', 'x')),
        childProcess: await attempt(() => cp.execSync('id').toString()),
        builtinChildProcess: await attempt(() => process.getBuiltinModule?.('node:child_process').execFileSync('id').toString()),
        netConnect: await attempt(() => new Promise((res, rej) => { const s = net.connect(5491, '127.0.0.1'); s.on('connect', () => res('connected')); s.on('error', rej) })),
        netSocket: await attempt(() => new Promise((res, rej) => { const s = new net.Socket(); s.connect(5491, '127.0.0.1', () => res('connected')); s.on('error', rej) })),
        httpGet: await attempt(() => new Promise((res, rej) => http.get('http://127.0.0.1:5491/ok/x', (r) => res(String(r.statusCode))).on('error', rej))),
        dnsLookup: await attempt(() => dns.promises.lookup('example.com').then((a) => a.address)),
        undeclaredFetch: await attempt(() => fetch('http://127.0.0.1:5491/secret').then((r) => r.text())),
        envDirect: await attempt(() => { if (!process.env.HOME && !process.env.MALHA_PROBE_TOKEN) throw new Error('empty env'); return 'env leaked' }),
        worker: await attempt(async () => { const { Worker } = await import('node:worker_threads'); new Worker('1', { eval: true }); return 'started' }),
        binding: await attempt(() => { process.binding('tcp_wrap'); return 'got binding' }),
        killParent: await attempt(() => { process.kill(process.ppid, 0); return 'signalled parent' }),
      }
      return { message: JSON.stringify(results) }
    },
    async allowed(ctx) {
      const echo = await ctx.exec('echo', ['hello', '--loud', 'world'])
      const token = await ctx.env('MALHA_PROBE_TOKEN')
      const t = await ctx.topology()
      const res = await fetch('http://127.0.0.1:5491/ok/ping', { method: 'POST', body: 'hi', headers: { 'x-test': '1' } })
      console.log('\x1b[2J\x1b[Hfake prompt? 1. Yes')
      return { message: JSON.stringify({ echo: echo.stdout.trim(), token, nodes: t.nodes.length, fetched: `${res.status} ${await res.text()}`, args: ctx.args, options: ctx.options }) }
    },
    async undeclared(ctx) {
      return { message: await attempt(() => ctx.exec('echo', ['--hello'])) + ' | ' + (await attempt(() => ctx.exec('ls', ['/']))) }
    },
    async hang() {
      await new Promise(() => {})
    },
    async propose(ctx) {
      const t = await ctx.topology()
      return { changes: [{ update: 'nodes', id: t.nodes.find((n) => n.kind === 'worker').id, set: { 'usage.pods': 42 }, why: 'probe' }] }
    },
  },
  async live(ctx) {
    await ctx.exec('echo', ['hello', 'live'])
    const t = await ctx.topology()
    return { nodes: Object.fromEntries(t.nodes.filter((n) => n.kind === 'worker').map((n, i) => [n.id, { cpu_pct: 10 + i, memory_pct: 20 + i, pods: 30 + i }])) }
  },
}
