// Porkbun as the registrar: what is registered there, when it expires, whether it renews itself.
// The API key pair comes from the environment or ~/.config; API access must be on for the account.

/** The first of these that is set: environment variables, then files. */
async function secret(ctx, env, ...files) {
  const value = await ctx.env(env)
  if (value) return value.trim()
  for (const file of files) {
    try {
      return (await ctx.readFile(file)).trim()
    } catch (e) {
      if (e.code !== 'MALHA_NOT_FOUND') throw e
    }
  }
  return undefined
}

async function listAll(ctx) {
  const apikey = await secret(ctx, 'PORKBUN_API_KEY', '~/.config/malha/porkbun-api-key', '~/.config/porkbun/api-key')
  const secretapikey = await secret(ctx, 'PORKBUN_SECRET_API_KEY', '~/.config/malha/porkbun-secret-api-key', '~/.config/porkbun/secret-api-key')
  if (!apikey || !secretapikey) throw new Error('no Porkbun API keys: set PORKBUN_API_KEY and PORKBUN_SECRET_API_KEY, or ~/.config/malha/porkbun-api-key and porkbun-secret-api-key')
  const all = []
  // listAll returns up to 1000 domains per call; page until a call returns none.
  for (let start = 0; ; start += 1000) {
    const res = await ctx.fetch('https://api.porkbun.com/api/json/v3/domain/listAll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apikey, secretapikey, start: String(start) }),
    })
    const body = await res.json().catch(() => ({}))
    if (body.status !== 'SUCCESS') throw new Error(`Porkbun: ${body.message ?? `HTTP ${res.status}`}`)
    if (!body.domains?.length) break
    all.push(...body.domains)
  }
  return all.map((d) => ({ name: d.domain.toLowerCase(), expires: d.expireDate.slice(0, 10), auto_renew: String(d.autoRenew) === '1' }))
}

export default {
  commands: {
    async sync(ctx) {
      const provider = typeof ctx.options.provider === 'string' ? ctx.options.provider : 'porkbun'
      const [topology, registered] = await Promise.all([ctx.topology(), listAll(ctx)])
      const changes = []
      if (!(topology.providers ?? []).some((p) => p.id === provider))
        changes.push({ add: 'providers', item: { id: provider, name: 'Porkbun', kind: 'saas' }, why: 'the domains name it as their registrar' })
      const current = new Map((topology.domains?.list ?? []).map((d) => [d.name, d]))
      for (const d of registered) {
        const have = current.get(d.name)
        if (!have) {
          changes.push({ add: 'domains', item: { name: d.name, registrar: provider, expires: d.expires, auto_renew: d.auto_renew }, why: 'registered at Porkbun' })
          continue
        }
        const set = {}
        if (have.registrar !== provider) set.registrar = provider
        if (have.expires !== d.expires) set.expires = d.expires
        if (have.auto_renew !== d.auto_renew) set.auto_renew = d.auto_renew
        if (Object.keys(set).length) changes.push({ update: 'domains', id: d.name, set })
      }
      const seen = new Set(registered.map((d) => d.name))
      const gone = [...current.values()].filter((d) => d.registrar === provider && !seen.has(d.name)).map((d) => d.name)
      if (topology.domains) changes.push({ set: { 'domains.checked': ctx.today }, why: 'checked against Porkbun' })
      const lines = [`${registered.length} domains registered at Porkbun.`]
      if (gone.length) lines.push(`Listed with registrar ${provider} here but not in the Porkbun account (transferred or lapsed?): ${gone.join(', ')}`)
      return { message: lines.join('\n'), changes }
    },
  },
}
