import { defineConfig } from 'vitest/config'

// Unit tests only; tests/e2e is Playwright's.
export default defineConfig({
  test: { include: ['tests/*.test.ts'] },
})
