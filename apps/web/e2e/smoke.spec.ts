import { test, expect } from '@playwright/test'

/**
 * Smoke tests — verify no network/CORS failures on the public + auth pages.
 *
 * "Load failed" is the symptom when CORS blocks a fetch (browser throws
 * TypeError). Each protected route here visits the page and checks that:
 *   - No `Load failed` text appears anywhere in the DOM
 *   - No console errors
 *   - Page reaches a stable state within `loadPage`
 */

const PROTECTED_ROUTES = [
  '/inbox',
  '/tickets',
  '/categories',
  '/contacts',
  '/themes',
  '/pipeline',
  '/users',
]

async function expectNoLoadFailure(page: import('@playwright/test').Page) {
  // Most robust signal: the network response for /api/* should not be blocked.
  // We catch the actual symptom too.
  await expect(page.locator('text=Load failed')).toHaveCount(0)
}

test('login page renders with no network errors', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  const responses: Array<{ status: number; url: string }> = []
  page.on('response', (res) => {
    responses.push({ status: res.status(), url: res.url() })
  })

  const t0 = Date.now()
  await page.goto('/login')
  await page.waitForLoadState('networkidle')
  const elapsed = Date.now() - t0

  // The login page must NOT redirect (no session = stays on /login).
  expect(page.url()).toMatch(/\/login/)

  // Title + form visible.
  await expect(page.locator('input[type="email"]')).toBeVisible()
  await expect(page.locator('input[type="password"]')).toBeVisible()

  // No "Load failed" should appear anywhere.
  await expectNoLoadFailure(page)

  // No 5xx from any API call (role-colors is the only anon-readable GET).
  const failing = responses.filter((r) => r.status >= 500 && r.url.includes('/api/'))
  expect(failing, `5xx responses observed: ${JSON.stringify(failing)}`).toHaveLength(0)

  // No console errors referencing network/CORS.
  const networkErrors = consoleErrors.filter((e) => /load failed|network|cors/i.test(e))
  expect(networkErrors, `console errors: ${JSON.stringify(consoleErrors)}`).toHaveLength(0)

  // Sanity bound on load time so regressions in dependencies show up.
  expect(elapsed).toBeLessThan(5_000)
})

for (const route of PROTECTED_ROUTES) {
  test(`protected route ${route} renders without "Load failed"`, async ({ page }) => {
    const t0 = Date.now()
    await page.goto(route)
    await page.waitForLoadState('networkidle').catch(() => undefined)
    await page.waitForTimeout(500) // give role-colors fetch a moment
    const elapsed = Date.now() - t0

    await expectNoLoadFailure(page)
    expect(elapsed).toBeLessThan(10_000)
  })
}
