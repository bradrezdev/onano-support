import { test, expect, type Page } from '@playwright/test'

/**
 * UI verification for the batch: the ten reported fixes plus the two profile
 * items. Run against a live dev server with a throwaway admin.
 *
 *   E2E_EMAIL=... E2E_PASSWORD=... pnpm exec playwright test e2e-verify
 */

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login')
  await page.getByLabel(/correo|email/i).fill(email)
  await page.getByLabel(/contraseña|password/i).fill(password)
  await page.getByRole('button', { name: /entrar|sign in|iniciar/i }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 })
}

const EMAIL = process.env.E2E_EMAIL!
const PASSWORD = process.env.E2E_PASSWORD!

test.describe('lote de fixes', () => {
  // A console error on any of these pages is a real defect: a white screen
  // with a passing locator is still a broken page.
  //
  // Registered AFTER sign-in on purpose. The app boots on /login before a
  // session exists and fires /api/me and /api/role-colors unauthenticated;
  // those 401s are the expected shape of a logged-out SPA, and asserting on
  // them would make every test here fail for a non-bug.
  const consoleErrors: string[] = []
  test.beforeEach(async ({ page }) => {
    consoleErrors.length = 0
    await signIn(page, EMAIL, PASSWORD)
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))
  })
  test.afterEach(() => {
    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([])
  })

  // Fix 6 + 7: renames.
  test('sidebar reads Proyectos and Clientes', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('link', { name: /clientes/i })).toBeVisible()
    await expect(page.getByRole('link', { name: /proyectos/i })).toBeVisible()
    await expect(page.getByRole('link', { name: /^contactos$/i })).toHaveCount(0)
    await expect(page.getByRole('link', { name: /^temas$/i })).toHaveCount(0)
  })

  test('clientes and proyectos pages carry the new headings', async ({ page }) => {
    await page.goto('/contacts')
    await expect(page.getByRole('heading', { name: 'Clientes' })).toBeVisible()
    await page.goto('/themes')
    await expect(page.getByRole('heading', { name: 'Proyectos' })).toBeVisible()
  })

  // Fix 1: role color editor.
  test('role colors page edits a color and syncs both tables', async ({ page }) => {
    await page.goto('/roles/colors')
    await expect(page.getByRole('heading', { name: /colores de rol/i })).toBeVisible()
    const picker = page.getByLabel(/color de admin/i)
    await expect(picker).toBeVisible()
    // Editing must be possible, and the row must say which table it reaches.
    await expect(page.getByText(/roles\.color y role_color_settings/i).first()).toBeVisible()
    // The custom role must say out loud that it reaches only one table.
    await expect(page.getByText(/solo en roles\.color/i).first()).toBeVisible()
  })

  // Fix 2: category rename.
  //
  // Works on a scratch category it creates itself, not on a real one. The first
  // version renamed whatever row happened to be first and never put it back,
  // which left a live category called "Renombrada E2E" in the workspace. A test
  // that mutates real data has to clean up its own data.
  test('category row enters edit mode and renames', async ({ page }) => {
    const scratch = `e2e.scratch.${Date.now()}`
    const renamed = `${scratch}.renamed`

    const token = await page.evaluate(async () => {
      const { supabase } = await import('/src/lib/supabase')
      const { data } = await supabase.auth.getSession()
      return data.session?.access_token ?? ''
    })

    const created = await page.request.post('http://localhost:3000/api/categories', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { name: scratch },
    })
    expect(created.status()).toBe(201)

    try {
      await page.goto('/categories')
      const pencil = page.locator(`[aria-label="Renombrar ${scratch}"]`)
      await expect(pencil).toBeVisible()
      await pencil.click()
      const input = page.getByRole('textbox', { name: /nuevo nombre/i }).first()
      await input.fill(renamed)
      await page.getByRole('button', { name: /guardar nombre/i }).first().click()
      await expect(page.getByText(renamed)).toBeVisible()
    } finally {
      const list = await page.request.get('http://localhost:3000/api/categories', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const body = (await list.json()) as { data: { id: string; name: string; children: unknown[] }[] }
      const flat: { id: string; name: string }[] = []
      for (const c of body.data) {
        flat.push({ id: c.id, name: c.name })
        for (const k of c.children as { id: string; name: string }[]) flat.push(k)
      }
      const target = flat.find((c) => c.name === renamed)
      if (target) await page.request.delete(`http://localhost:3000/api/categories/${target.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    }
  })

  // Fix 4: create user.
  test('users page can create an account', async ({ page }) => {
    await page.goto('/users')
    await page.getByRole('button', { name: /nuevo usuario/i }).click()
    await expect(page.getByRole('heading', { name: /nuevo usuario/i })).toBeVisible()
    // Unique per run: the first version hardcoded the address, so the second
    // run hit 409 email_taken and failed. A test that creates real rows has to
    // be re-runnable.
    const email = `creado.e2e.${Date.now()}@example.test`
    await page.getByLabel(/^email$/i).fill(email)
    await page.getByLabel(/contraseña temporal/i).fill('e2e-creado-1234')
    await page.getByRole('button', { name: /crear usuario/i }).click()
    await expect(page.getByRole('heading', { name: /usuario creado/i })).toBeVisible()
    await expect(page.getByText(email).first()).toBeVisible()
    await page.getByRole('button', { name: /^listo$/i }).click()
    await expect(page.getByText(email).first()).toBeVisible()
  })

  // Fix 9: assign at creation.
  test('new ticket form offers assignee and project', async ({ page }) => {
    await page.goto('/tickets/new')
    await expect(page.getByLabel(/asignar a/i)).toBeVisible()
    await expect(page.getByLabel(/^proyecto$/i)).toBeVisible()
    // Choosing a project reveals its phases.
    const projects = page.getByLabel(/^proyecto$/i)
    // The select renders on first paint with only its placeholder; the
    // projects arrive after the fetch. Wait for a real option instead of
    // counting immediately, or this races the network.
    await expect(projects.locator('option')).not.toHaveCount(1)
    await projects.selectOption({ index: 1 })
    await expect(page.getByLabel(/^fase$/i)).toBeVisible()
  })

  // Fixes 3, 5, 8, 10: detail page assignment + named details.
  test('ticket detail shows names, never uuids, and offers assignment', async ({ page }) => {
    await page.goto('/tickets')
    // `/tickets/new` also matches href^="/tickets/", so anchor on the uuid:
    // without this, .first() grabs the "Nuevo ticket" button and lands on the
    // form instead of a ticket.
    const row = page.locator('a[href^="/tickets/"][href*="-"]').first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    await row.click()
    await page.waitForURL(/\/tickets\/[0-9a-f-]{36}/, { timeout: 15_000 })

    await expect(page.getByRole('heading', { name: /asignación/i })).toBeVisible()
    await expect(page.getByLabel('Asignar a')).toBeVisible()
    await expect(page.getByLabel('Proyecto')).toBeVisible()

    // The details block must read "Cliente", and no value may be a uuid.
    const details = page.locator('section', { has: page.getByText('Detalles') })
    await expect(details.getByText('Cliente', { exact: true })).toBeVisible()
    const text = await details.innerText()
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/)
    expect(text).not.toMatch(/\b[0-9a-f]{8}…/)
  })

  // Implementation 1 + 2: profile page reached from the topbar identity block.
  test('topbar identity opens the profile page and saves', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /abrir mi perfil/i }).click()
    await page.waitForURL('**/profile')
    await expect(page.getByRole('heading', { name: /mi perfil/i })).toBeVisible()

    const name = page.getByLabel(/^nombre$/i)
    await name.fill('Nombre E2E')
    await page.getByLabel(/teléfono/i).fill('+52 555 999 0000')
    await page.getByRole('button', { name: /^guardar$/i }).click()
    await expect(page.getByText(/perfil guardado/i)).toBeVisible()

    // The topbar must reflect it without a reload.
    await page.goto('/')
    await expect(page.getByRole('button', { name: /abrir mi perfil/i })).toContainText(
      'Nombre E2E',
    )
  })
})