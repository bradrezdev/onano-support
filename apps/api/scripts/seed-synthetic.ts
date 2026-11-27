/**
 * Siembra datos SINTÉTICOS en la instancia efímera: dos cuentas (una
 * administradora y una agente sin permisos administrativos), un cliente, una
 * categoría, un proyecto con dos fases y un ticket con su conversación.
 *
 * Todo es desechable y lleva el prefijo `e2e.`: nada de esto puede confundirse
 * con datos reales, y la base efímera desaparece con el runner.
 *
 * Idempotente: si la cuenta ya existe, se reutiliza. Volver a correrlo no
 * debe fallar ni duplicar.
 *
 *   cd apps/api && pnpm tsx scripts/seed-synthetic.ts
 */
import 'dotenv/config'
import { createSupabaseAdminClient } from '../src/lib/supabase/admin'

const PASSWORD = 'E2E-sintetico-9931'
const ADMIN_EMAIL = 'e2e.admin@example.test'
const AGENT_EMAIL = 'e2e.agent@example.test'

/** Crea la cuenta y su perfil, o reutiliza la que ya existe. */
async function ensureUser(
  email: string,
  displayName: string,
  roleKey: string,
): Promise<string> {
  const admin = createSupabaseAdminClient()

  const { data: list, error: listErr } = await admin.auth.admin.listUsers({
    page: 1,
    perPage: 200,
  })
  if (listErr) throw new Error(`listUsers: ${listErr.message}`)

  const existing = list.users.find((u) => u.email?.toLowerCase() === email)
  let id = existing?.id

  if (!id) {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { display_name: displayName },
    })
    if (error) throw new Error(`createUser(${email}): ${error.message}`)
    id = data.user.id
  } else {
    // La contraseña se restablece para que una corrida repetida no herede una
    // contraseña cambiada a mano.
    const { error } = await admin.auth.admin.updateUserById(id, {
      password: PASSWORD,
      email_confirm: true,
    })
    if (error) throw new Error(`updateUserById(${email}): ${error.message}`)
  }

  // El trigger `handle_new_user` crea el perfil con role='soporte'; aquí se
  // fija el rol real y el nombre.
  const { error: upErr } = await admin
    .from('profiles')
    .update({ role_key: roleKey, role: roleKey, display_name: displayName })
    .eq('id', id)
  if (upErr) throw new Error(`profile(${email}): ${upErr.message}`)

  return id
}

async function main() {
  const admin = createSupabaseAdminClient()

  const adminId = await ensureUser(ADMIN_EMAIL, 'E2E Administrador', 'admin')
  const agentId = await ensureUser(AGENT_EMAIL, 'E2E Agente', 'soporte')

  // Categoría
  const { data: existingCat } = await admin
    .from('categories')
    .select('id')
    .eq('name', 'e2e.Soporte general')
    .maybeSingle<{ id: string }>()
  let categoryId = existingCat?.id
  if (!categoryId) {
    const { data, error } = await admin
      .from('categories')
      .insert({ name: 'e2e.Soporte general', created_by: adminId })
      .select('id')
      .single<{ id: string }>()
    if (error) throw new Error(`categories: ${error.message}`)
    categoryId = data.id
  }

  // Cliente
  const phone = '+525550000001'
  const { data: existingContact } = await admin
    .from('contacts')
    .select('id')
    .eq('whatsapp_number', phone)
    .maybeSingle<{ id: string }>()
  let contactId = existingContact?.id
  if (!contactId) {
    const { data, error } = await admin
      .from('contacts')
      .insert({ whatsapp_number: phone, name: 'e2e.Cliente Sintético', country: 'MX' })
      .select('id')
      .single<{ id: string }>()
    if (error) throw new Error(`contacts: ${error.message}`)
    contactId = data.id
  }

  // Proyecto (theme) y fases (flows)
  const { data: existingTheme } = await admin
    .from('themes')
    .select('id')
    .eq('name', 'e2e.Proyecto')
    .maybeSingle<{ id: string }>()
  let themeId = existingTheme?.id
  if (!themeId) {
    const { data, error } = await admin
      .from('themes')
      .insert({ name: 'e2e.Proyecto', description: 'Proyecto sintético', created_by: adminId })
      .select('id')
      .single<{ id: string }>()
    if (error) throw new Error(`themes: ${error.message}`)
    themeId = data.id
  }

  const { data: existingFlow } = await admin
    .from('flows')
    .select('id')
    .eq('theme_id', themeId)
    .eq('name', 'e2e.Fase 1')
    .maybeSingle<{ id: string }>()
  let flowId = existingFlow?.id
  if (!flowId) {
    const { data, error } = await admin
      .from('flows')
      .insert({ theme_id: themeId, name: 'e2e.Fase 1', position: 0 })
      .select('id')
      .single<{ id: string }>()
    if (error) throw new Error(`flows: ${error.message}`)
    flowId = data.id
  }
  const { data: secondFlow } = await admin
    .from('flows')
    .select('id')
    .eq('theme_id', themeId)
    .eq('name', 'e2e.Fase 2')
    .maybeSingle<{ id: string }>()
  if (!secondFlow) {
    const { error } = await admin
      .from('flows')
      .insert({ theme_id: themeId, name: 'e2e.Fase 2', position: 1, is_terminal: true })
    if (error) throw new Error(`flows(2): ${error.message}`)
  }

  // Ticket
  const { data: existingTicket } = await admin
    .from('tickets')
    .select('id')
    .eq('name', 'e2e.Ticket de verificación')
    .maybeSingle<{ id: string }>()
  let ticketId = existingTicket?.id
  if (!ticketId) {
    const { data, error } = await admin
      .from('tickets')
      .insert({
        contact_id: contactId,
        category_id: categoryId,
        theme_id: themeId,
        flow_id: flowId,
        assigned_to: agentId,
        name: 'e2e.Ticket de verificación',
        description: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Ticket sintético.' }] },
          ],
        },
        description_plain: 'Ticket sintético.',
        created_by: adminId,
      })
      .select('id')
      .single<{ id: string }>()
    if (error) throw new Error(`tickets: ${error.message}`)
    ticketId = data.id
  }

  // Conversación con un mensaje, para que la bandeja no esté vacía
  const { data: existingConv } = await admin
    .from('conversations')
    .select('id')
    .eq('contact_id', contactId)
    .maybeSingle<{ id: string }>()
  let conversationId = existingConv?.id
  if (!conversationId) {
    const { data, error } = await admin
      .from('conversations')
      .insert({
        contact_id: contactId,
        assigned_agent_id: agentId,
        status: 'open',
        last_message_at: new Date().toISOString(),
        last_message_preview: 'Mensaje sintético de entrada',
        unread_count: 1,
      })
      .select('id')
      .single<{ id: string }>()
    if (error) throw new Error(`conversations: ${error.message}`)
    conversationId = data.id
  }

  const { data: existingMsg } = await admin
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .maybeSingle<{ id: string }>()
  if (!existingMsg) {
    const { error } = await admin.from('messages').insert({
      conversation_id: conversationId,
      direction: 'in',
      body: 'Mensaje sintético de entrada',
    })
    if (error) throw new Error(`messages: ${error.message}`)
  }

  // Las credenciales sintéticas se publican para los pasos siguientes. No hay
  // ningún secreto aquí: son valores fijos de una base efímera.
  const out = {
    E2E_EMAIL: ADMIN_EMAIL,
    E2E_ADMIN_EMAIL: ADMIN_EMAIL,
    E2E_AGENT_EMAIL: AGENT_EMAIL,
    E2E_PASSWORD: PASSWORD,
    E2E_TICKET_ID: ticketId,
  }
  if (process.env.GITHUB_ENV) {
    const { appendFileSync } = await import('node:fs')
    for (const [k, v] of Object.entries(out)) {
      appendFileSync(process.env.GITHUB_ENV, `${k}=${v}\n`)
    }
  }
  console.log('Datos sintéticos listos:')
  console.log(`  admin=${ADMIN_EMAIL} agent=${AGENT_EMAIL}`)
  console.log(`  ticket=${ticketId} contact=${contactId} category=${categoryId}`)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exitCode = 1
})
