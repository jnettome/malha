export default {
  async notify(ctx, report) {
    if (ctx.options.fail) return { sent: false, message: 'told to fail' }
    return { sent: true, message: JSON.stringify({ findings: report.findings.map((f) => f.id), resolved: report.resolved.map((r) => r.id), digest: report.digest, open: report.open }) }
  },
}
