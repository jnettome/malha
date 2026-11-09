// Posts a malha check report to a Slack incoming webhook.

const AREAS = [
  ['Domains', ['domain-expiry', 'domain-untracked', 'domain-no-autorenew', 'domain-unlisted']],
  ['Nodes', ['node-degraded', 'pod-pressure']],
  ['Databases', ['single-node-database']],
  ['Dependencies', ['scan-stale', 'vulnerability']],
  ['Traffic', ['analytics-stale', 'analytics-error', 'traffic-drop']],
]
const SHOWN = 10
const MARK = { critical: ':red_circle:', warning: ':large_yellow_circle:' }
// Slack's mrkdwn treats these three as markup.
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

async function webhook(ctx) {
  const url = await ctx.env('SLACK_WEBHOOK_URL')
  if (url) return url.trim()
  try {
    return (await ctx.readFile('~/.config/malha/slack-webhook')).trim()
  } catch (e) {
    if (e.code === 'MALHA_NOT_FOUND') return undefined
    throw e
  }
}

function lines(report) {
  const critical = report.findings.filter((f) => f.severity === 'critical').length
  const head = report.digest ? `${report.open} open` : `${report.findings.length} new or worse${critical ? ` (${critical} critical)` : ''} · ${report.open} open`
  const out = [`*${esc(report.project)}* · malha check · ${head}`]
  for (const [area, checks] of AREAS) {
    const items = report.findings.filter((f) => checks.includes(f.check))
    if (!items.length) continue
    out.push('', `*${area}*`)
    const vulns = items.filter((f) => f.check === 'vulnerability')
    for (const f of [...items.filter((f) => f.check !== 'vulnerability'), ...vulns.slice(0, SHOWN)]) out.push(`${MARK[f.severity]} ${esc(f.title)}${f.detail ? ` · ${esc(f.detail)}` : ''}`)
    if (vulns.length > SHOWN) out.push(`… and ${vulns.length - SHOWN} more advisories`)
  }
  if (report.resolved.length) out.push('', '*Resolved*', ...report.resolved.map((r) => `:white_check_mark: ${esc(r.title)}`))
  out.push('', `\`${esc(report.command)}\``)
  return out
}

export default {
  async notify(ctx, report) {
    const url = await webhook(ctx)
    if (!url) return { sent: false, message: 'no webhook: set SLACK_WEBHOOK_URL, or put the URL in ~/.config/malha/slack-webhook' }
    const all = lines(report)
    const messages = []
    for (const line of all) {
      const last = messages.at(-1)
      if (last !== undefined && last.length + line.length < 3500) messages[messages.length - 1] = `${last}\n${line}`
      else messages.push(line)
    }
    for (const text of messages) {
      const res = await ctx.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
      if (!res.ok) throw new Error(`Slack answered ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
    return { sent: true, message: `posted ${messages.length} message(s) to Slack` }
  },
}
