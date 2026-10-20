import { test as base, expect, type Page } from '@playwright/test'

/**
 * Authentication helper: sign in via the Login page UI. Requires a
 * working admin user. Set E2E_EMAIL + E2E_PASSWORD in the environment
 * for the protected tests.
 */
export async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login')
  await page.getByLabel(/email/i).fill(email)
  await page.getByLabel(/password/i).fill(password)
  await page.getByRole('button', { name: /sign in|iniciar|entrar/i }).click()
  // Wait for redirect away from /login.
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 })
}

export const test = base.extend({
  signedInPage: async ({ page }, use, testInfo) => {
    const email = process.env.E2E_EMAIL
    const password = process.env.E2E_PASSWORD
    test.skip(!email || !password, 'E2E_EMAIL/E2E_PASSWORD not set — skipping protected route')
    await signIn(page, email!, password!)
    await use(page)
  },
})

export { expect }
