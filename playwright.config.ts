import { defineConfig } from '@playwright/test'

// Runs against the built CLI (`npm run build` first), the way users get it.
// PLAYWRIGHT_CHROME points at a local Chrome instead of Playwright's own download.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  fullyParallel: true,
  use: {
    baseURL: 'http://127.0.0.1:5410',
    launchOptions: process.env.PLAYWRIGHT_CHROME ? { executablePath: process.env.PLAYWRIGHT_CHROME } : {},
  },
  webServer: {
    command: 'node dist/cli/index.js dev examples/acme/topology.yaml --port 5410',
    url: 'http://127.0.0.1:5410',
    reuseExistingServer: false,
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
})
