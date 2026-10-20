import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright E2E config for the CRM web SPA.
 *
 * Dev server is started by Playwright on demand for local runs, or
 * expected to be already up for CI (set BASE_URL to skip webServer).
 *
 * Auth: tests run against the live dev environment with the admin user
 * the operator already provisioned. Use the `login` fixture in helpers/
 * to authenticate before protected tests.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: true,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: process.env.BASE_URL
    ? undefined
    : {
        command: 'pnpm dev',
        url: 'http://localhost:5173',
        reuseExistingServer: true,
        timeout: 60_000,
      },
})
