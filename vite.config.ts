import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { createApi, type Api } from './src/cli/api.ts'
import { report } from './src/cli/dev.ts'
import { loadTopology } from './src/cli/load.ts'

// Developing Malha itself: `npm run dev` serves the viewer from source against the Acme example
// (or MALHA_FILE), through the same api/ handlers `malha dev` uses.
function malhaApi(): Plugin {
  const file = resolve(process.env.MALHA_FILE ?? 'examples/acme/topology.yaml')
  let api: Api | undefined
  return {
    name: 'malha-api',
    apply: (_config, env) => env.command === 'serve' && !process.env.VITEST,
    configureServer(server) {
      report(file, loadTopology(file))
      api = createApi(file, { onReload: (r) => report(file, r), plugins: true, loopback: true })
      server.middlewares.use((req, res, next) => (api!.handle(req, res) ? undefined : next()))
      server.httpServer?.on('close', () => api!.close())
    },
    transformIndexHtml: (html) => api?.injectToken(html) ?? html,
  }
}

export default defineConfig({
  // Relative asset paths, so a `malha build` works under any path on a static host.
  base: './',
  plugins: [react(), malhaApi()],
  server: { port: 5299 },
  build: {
    outDir: 'dist/viewer',
    emptyOutDir: true,
    // The app is one bundle; React Flow and Motion are most of it.
    chunkSizeWarningLimit: 900,
  },
})
