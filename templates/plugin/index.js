// A Malha plugin. It runs in a sandbox: it can read only this folder, and reaches everything else
// through `ctx`, which asks the user first. Malha never runs `npm install` for a plugin, so keep it
// to plain JavaScript, or bundle any dependencies into this folder.
// API: https://github.com/jnettome/malha/blob/main/docs/plugins.md

/** @type {import('@malha/cli/plugin').Plugin} */
export default {
  commands: {
    async hello(ctx) {
      const topology = await ctx.topology()
      // Allowed by "uname -n" in malha-plugin.json; the user is asked the first time.
      const { stdout } = await ctx.exec('uname', ['-n'])
      console.log(`Hello from ${stdout.trim()}. ${topology.meta.name} has ${topology.nodes.length} nodes.`)

      // Changes are proposals: Malha shows the diff and writes only if the user says yes.
      return {
        message: 'Proposing to record when this plugin last ran.',
        changes: [{ meta: { checked: ctx.today }, why: 'hello plugin ran' }],
      }
    },
  },
}
