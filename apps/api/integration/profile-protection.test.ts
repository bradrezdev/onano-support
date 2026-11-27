import { describe, it, expect, beforeAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'

/**
 * E1 · Protección de perfiles — aceptación con usuarios SINTÉTICOS contra una
 * base real (S11/S12).
 *
 * Esta suite NO usa mocks: habla con la API que está corriendo y con la base
 * a través del cliente de `service_role` (solo para leer y comprobar). El
 * objeto de la prueba es exactamente la pregunta que el resto del código no
 * puede responder:
 *
 *   ¿Quién puede cambiar cada campo protegido?
 *
 *   · Agente → campo personal permitido: el cambio PERSISTE.
 *   · Agente → campos administrativos: conservan su valor, tanto por la API
 *     (403) como por acceso directo a los datos (permiso revocado).
 *   · Administrador → cambio de rol: PERSISTE y queda AUDITADO.
 *
 * Fuera de una instancia efímera la suite se omite entera (y queda dicho),
 * nunca pasa en verde sin haber ejecutado nada.
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000'
const SB_URL = process.env.SUPABASE_URL
const PUBLISHABLE = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
const SERVICE = process.env.SUPABASE_SECRET_KEY
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL
const AGENT_EMAIL = process.env.E2E_AGENT_EMAIL
const PASSWORD = process.env.E2E_PASSWORD

const enabled = Boolean(SB_URL && PUBLISHABLE && SERVICE && ADMIN_EMAIL && AGENT_EMAIL && PASSWORD)

if (!enabled) {
  console.warn(
    '[e1] Suite omitida: no hay instancia efímera (SUPABASE_URL, clave publicable, ' +
      'service_role o credenciales sintéticas).',
  )
}

async function signIn(email: string, password: string): Promise<string> {
  const client = createClient(SB_URL!, PUBLISHABLE!, { auth: { persistSession: false } })
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`signIn(${email}): ${error.message}`)
  const token = data.session?.access_token
  if (!token) throw new Error(`signIn(${email}): sin token`)
  return token
}

async function api(
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const text = await res.text()
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: res.status, body }
}

describe.skipIf(!enabled)('E1 · quién puede cambiar cada campo protegido', () => {
  let adminToken = ''
  let agentToken = ''
  let agentId = ''
  let service: ReturnType<typeof createClient>

  beforeAll(async () => {
    service = createClient(SB_URL!, SERVICE!, { auth: { persistSession: false } })
    adminToken = await signIn(ADMIN_EMAIL!, PASSWORD!)
    agentToken = await signIn(AGENT_EMAIL!, PASSWORD!)
    const me = await api(agentToken, '/api/me')
    agentId = me.body?.data?.id
    expect(agentId).toBeTruthy()
  })

  it('el agente edita un campo personal permitido y el cambio persiste', async () => {
    const nombre = 'Nombre Sintético E2E'
    const res = await api(agentToken, '/api/me', {
      method: 'PATCH',
      body: { display_name: nombre },
    })
    expect(res.status).toBe(200)

    const { data, error } = await service
      .from('profiles')
      .select('display_name')
      .eq('id', agentId)
      .single<{ display_name: string }>()
    expect(error).toBeNull()
    expect(data?.display_name).toBe(nombre)
  })

  it('el agente no cambia campos administrativos por la API', async () => {
    const before = await service
      .from('profiles')
      .select('role_key')
      .eq('id', agentId)
      .single<{ role_key: string }>()

    const res = await api(agentToken, `/api/users/${agentId}`, {
      method: 'PATCH',
      body: { role: 'admin' },
    })
    expect(res.status).toBe(403)

    const after = await service
      .from('profiles')
      .select('role_key')
      .eq('id', agentId)
      .single<{ role_key: string }>()
    expect(after.data?.role_key).toBe(before.data?.role_key)
    expect(after.data?.role_key).toBe('soporte')
  })

  it('el acceso directo a los datos tampoco puede cambiar el rol', async () => {
    // El mismo intento, pero saltándose la API: REST con la clave publicable
    // y el token del agente. Los privilegios de escritura están revocados.
    const browser = createClient(SB_URL!, PUBLISHABLE!, { auth: { persistSession: false } })
    const { error } = await browser
      .from('profiles')
      .update({ role_key: 'admin' })
      .eq('id', agentId)
      .select('id')
    expect(error).not.toBeNull()

    const after = await service
      .from('profiles')
      .select('role_key')
      .eq('id', agentId)
      .single<{ role_key: string }>()
    expect(after.data?.role_key).toBe('soporte')
  })

  it('el administrador cambia un rol y el cambio queda auditado', async () => {
    const res = await api(adminToken, `/api/users/${agentId}`, {
      method: 'PATCH',
      body: { role: 'supervisor' },
    })
    expect(res.status).toBe(200)

    const after = await service
      .from('profiles')
      .select('role_key')
      .eq('id', agentId)
      .single<{ role_key: string }>()
    expect(after.data?.role_key).toBe('supervisor')

    const { data: entries, error } = await service
      .from('admin_audit_log')
      .select('action, resource_type, resource_id, before, after')
      .eq('resource_id', agentId)
      .eq('action', 'user.profile_updated')
      .order('created_at', { ascending: false })
    expect(error).toBeNull()
    expect((entries ?? []).length).toBeGreaterThan(0)
    const entry = entries![0] as { after: { role_key?: string } }
    expect(entry.after?.role_key).toBe('supervisor')
  })

  it('el agente no puede leer el catálogo de roles por acceso directo', async () => {
    const browser = createClient(SB_URL!, PUBLISHABLE!, { auth: { persistSession: false } })
    const { data, error } = await browser.from('roles').select('key').limit(5)
    expect(error).not.toBeNull()
    expect(data ?? []).toEqual([])
  })

  it('el rol del agente vuelve a soporte (limpieza del caso)', async () => {
    const res = await api(adminToken, `/api/users/${agentId}`, {
      method: 'PATCH',
      body: { role: 'soporte' },
    })
    expect(res.status).toBe(200)
    const after = await service
      .from('profiles')
      .select('role_key')
      .eq('id', agentId)
      .single<{ role_key: string }>()
    expect(after.data?.role_key).toBe('soporte')
  })
})
