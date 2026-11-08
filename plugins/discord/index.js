// Posts a malha check report to a Discord webhook. Messages are split at 2000 characters.

const AREAS = [
  ['Domains', ['domain-expiry', 'domain-untracked', 'domain-no-autorenew', 'domain-unlisted']],
  ['Nodes', ['node-degraded', 'pod-pressure']],
  ['Databases', ['single-node-database']],
  ['Dependencies', ['scan-stale', 'vulnerability']],
]
const SHOWN = 10
const MARK = { critical: '🔴', warning: '🟡' }

async function webhook(ctx) {
  const url = await ctx.env('DISCORD_WEBHOOK_URL')
  if (url) return url.trim()
  try {
    return (await ctx.readFile('~/.config/malha/discord-webhook')).trim()
  } catch (e) {
    if (e.code === 'MALHA_NOT_FOUND') return undefined
    throw e
  }
}

/** Markdown lines: the findings by area, the resolved ones, and how to see everything. */
export function lines(report) {
  const critical = report.findings.filter((f) => f.severity === 'critical').length
  const head = report.digest ? `${report.open} open` : `${report.findings.length} new or worse${critical ? ` (${critical} critical)` : ''} · ${report.open} open`
  const out = [`**${report.project}** · malha check · ${head}`]
  for (const [area, checks] of AREAS) {
    const items = report.findings.filter((f) => checks.includes(f.check))
    if (!items.length) continue
    out.push('', `**${area}**`)
    const vulns = items.filter((f) => f.check === 'vulnerability')
    for (const f of [...items.filter((f) => f.check !== 'vulnerability'), ...vulns.slice(0, SHOWN)]) out.push(`${MARK[f.severity]} ${f.title}${f.detail ? ` · ${f.detail}` : ''}`)
    if (vulns.length > SHOWN) out.push(`… and ${vulns.length - SHOWN} more advisories`)
  }
  if (report.resolved.length) out.push('', '**Resolved**', ...report.resolved.map((r) => `✅ ${r.title}`))
  out.push('', `\`${report.command}\``)
  return out
}

/** Join lines into messages under the limit, breaking only between lines. */
export function chunks(all, limit) {
  const out = []
  let current = ''
  for (const raw of all) {
    const line = raw.length > limit ? `${raw.slice(0, limit - 1)}…` : raw
    if (current && current.length + line.length + 1 > limit) {
      out.push(current)
      current = ''
    }
    current = current ? `${current}\n${line}` : line
  }
  if (current) out.push(current)
  return out
}

export default {
  async notify(ctx, report) {
    const url = await webhook(ctx)
    if (!url) return { sent: false, message: 'no webhook: set DISCORD_WEBHOOK_URL, or put the URL in ~/.config/malha/discord-webhook' }
    const messages = chunks(lines(report), 1900)
    for (const content of messages) {
      for (let attempt = 0; ; attempt++) {
        const res = await ctx.fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // No @mentions, whatever a finding's text says.
          body: JSON.stringify({ username: 'Malha', content, allowed_mentions: { parse: [] } }),
        })
        if (res.ok) break
        if (res.status === 429 && attempt < 2) {
          const wait = Number((await res.json().catch(() => ({}))).retry_after ?? 1)
          await new Promise((r) => setTimeout(r, Math.min(wait, 10) * 1000))
          continue
        }
        throw new Error(`Discord answered ${res.status}: ${(await res.text()).slice(0, 200)}`)
      }
    }
    return { sent: true, message: `posted ${messages.length} message(s) to Discord` }
  },
}
