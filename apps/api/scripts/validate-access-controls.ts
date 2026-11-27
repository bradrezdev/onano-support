/**
 * Validación de los controles de acceso ANTES de habilitar datos reales.
 *
 * Tres controles, tal como los pide el plan:
 *   A · Dos agentes toman el mismo chat a la vez → queda un solo titular.
 *   B · Un agente ajeno al chat → sin historial y sin adjuntos.
 *   C · Una transferencia autorizada → cambia el titular y registra quién la
 *       hizo y por qué.
 *
 * El script NO falla cuando un control está pendiente: lo dice. La salida es
 * un informe, y el veredicto final dice si el entorno puede recibir datos
 * reales. Un control pendiente significa entorno sintético.
 *
 *   cd apps/api && pnpm tsx scripts/validate-access-controls.ts
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000'
const SB_URL = process.env.SUPABASE_URL
const PUBLISHABLE = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
const SERVICE = process.env.SUPABASE_SECRET_KEY
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'e2e.admin@example.test'
const AGENT_EMAIL = process.env.E2E_AGENT_EMAIL ?? 'e2e.agent@example.test'
const AGENT2_EMAIL = process.env.E2E_AGENT2_EMAIL ?? 'e2e.agent2@example.test'
const PASSWORD = process.env.E2E_PASSWORD ?? 'E2E-sintetico-9931'

type Verdict = 'OK' | 'PENDIENTE'
const results: { control: string; verdict: Verdict; detail: string }[] = []

function report(control: string, verdict: Verdict, detail: string) {
  results.push({ control, verdict, detail })
  console.log(`[${verdict}] ${control}\n       ${detail}`)
}

async function signIn(email: string): Promise<string> {
  const c = createClient(SB_URL!, PUBLISHABLE!, { auth: { persistSession: false } })
  const { data, error } = await c.auth.signInWithPassword({ email, password: PASSWORD })
  if (error) throw new Error(`signIn(${email}): ${error.message}`)
  const token = data.session?.access_token
  if (!token) throw new Error(`signIn(${email}): sin token`)
  return token
}

async function call(
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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

async function main() {
  if (!SB_URL || !PUBLISHABLE || !SERVICE) {
    console.error('FALLO: faltan SUPABASE_URL, la clave publicable o service_role.')
    process.exit(1)
  }

  const service = createClient(SB_URL, SERVICE, { auth: { persistSession: false } })
  const adminToken = await signIn(ADMIN_EMAIL)
  const agentToken = await signIn(AGENT_EMAIL)
  const agent2Token = await signIn(AGENT2_EMAIL)

  // Identificadores de las cuentas sintéticas (el email es la identidad de
  // Auth; el id del perfil es el mismo).
  const { data: list } = await service.auth.admin.listUsers({ page: 1, perPage: 200 })
  const users = list?.users ?? []
  const idOf = (email: string): string => {
    const u = users.find((x) => x.email?.toLowerCase() === email.toLowerCase())
    if (!u) throw new Error(`no encuentro la cuenta ${email}`)
    return u.id
  }
  const agentId = idOf(AGENT_EMAIL)
  const agent2Id = idOf(AGENT2_EMAIL)

  // Conversación SIN titular, para la toma simultánea.
  const { data: contact } = await service
    .from('contacts')
    .select('id')
    .eq('whatsapp_number', '+525550000001')
    .maybeSingle<{ id: string }>()
  if (!contact) throw new Error('no hay cliente sintético: corre la semilla')

  const { data: ticket } = await service
    .from('tickets')
    .select('id')
    .eq('name', 'e2e.Ticket de verificación')
    .maybeSingle<{ id: string }>()

  const { data: conversation, error: convErr } = await service
    .from('conversations')
    .insert({
      contact_id: contact.id,
      assigned_agent_id: null,
      status: 'open',
      last_message_at: new Date().toISOString(),
      last_message_preview: 'Conversación de validación',
      unread_count: 0,
    })
    .select('id')
    .single<{ id: string }>()
  if (convErr) throw new Error(`conversations: ${convErr.message}`)
  const convId = conversation.id

  // ---------------------------------------------------------------------
  // A · Dos agentes toman el mismo chat a la vez
  // ---------------------------------------------------------------------
  const [a, b] = await Promise.all([
    call(agentToken, `/api/conversations/${convId}/take`, { method: 'POST' }),
    call(agent2Token, `/api/conversations/${convId}/take`, { method: 'POST' }),
  ])
  const ok = [a, b].filter((r) => r.status === 200).length
  const conflicts = [a, b].filter((r) => r.status === 409).length
  const { data: owner } = await service
    .from('conversations')
    .select('assigned_agent_id')
    .eq('id', convId)
    .single<{ assigned_agent_id: string | null }>()

  if (ok === 1 && conflicts === 1 && owner?.assigned_agent_id) {
    report(
      'A · toma simultánea del mismo chat',
      'OK',
      `exactamente una toma prosperó (200) y la otra fue rechazada (409); ` +
        `titular único=${owner.assigned_agent_id.slice(0, 8)}…`,
    )
  } else {
    report(
      'A · toma simultánea del mismo chat',
      'PENDIENTE',
      `200=${ok} 409=${conflicts} titular=${owner?.assigned_agent_id ?? 'null'}: ` +
        'la toma no es un único ganador.',
    )
  }

  // ---------------------------------------------------------------------
  // B · Un agente ajeno al chat
  // ---------------------------------------------------------------------
  // "Ajeno" es el que NO ganó la toma: el identificador del titular se lee
  // de la base, no se supone.
  const ownerId = owner?.assigned_agent_id ?? null
  const outsiderToken = ownerId === agentId ? agent2Token : agentToken
  const outsiderLabel = ownerId === agentId ? AGENT2_EMAIL : AGENT_EMAIL

  const detail = await call(outsiderToken, `/api/conversations/${convId}`)
  if (detail.status === 403) {
    report(
      'B1 · lectura del detalle de la conversación ajena',
      'OK',
      `el agente ajeno (${outsiderLabel}) recibe 403`,
    )
  } else {
    report(
      'B1 · lectura del detalle de la conversación ajena',
      'PENDIENTE',
      `el agente ajeno (${outsiderLabel}) recibió ${detail.status}: el detalle no se filtra por chat.`,
    )
  }

  const messages = await call(outsiderToken, `/api/conversations/${convId}/messages`, {
    method: 'POST',
    body: { body: 'Mensaje de un agente que no es el titular' },
  })
  if (messages.status === 403 || messages.status === 404) {
    report(
      'B2 · envío de mensajes a la conversación ajena',
      'OK',
      `el agente ajeno recibe ${messages.status}`,
    )
  } else {
    report(
      'B2 · envío de mensajes a la conversación ajena',
      'PENDIENTE',
      `el agente ajeno recibió ${messages.status}: puede escribir en un chat que no es suyo.`,
    )
  }

  if (ticket) {
    const att = await call(outsiderToken, `/api/tickets/${ticket.id}/attachments`)
    if (att.status === 403 || att.status === 404) {
      report('B3 · adjuntos del ticket ajeno', 'OK', `recibe ${att.status}`)
    } else {
      report(
        'B3 · adjuntos del ticket ajeno',
        'PENDIENTE',
        `el agente ajeno recibió ${att.status}: los adjuntos NO se filtran.`,
      )
    }
  }

  // ---------------------------------------------------------------------
  // C · Transferencia autorizada: cambia el titular y queda registrada
  // ---------------------------------------------------------------------
  const { data: beforeOwner } = await service
    .from('conversations')
    .select('assigned_agent_id')
    .eq('id', convId)
    .single<{ assigned_agent_id: string | null }>()

  const transfer = await call(adminToken, `/api/conversations/${convId}`, {
    method: 'PATCH',
    body: { assigned_agent_id: null },
  })
  const { data: afterOwner } = await service
    .from('conversations')
    .select('assigned_agent_id')
    .eq('id', convId)
    .single<{ assigned_agent_id: string | null }>()

  const changed = beforeOwner?.assigned_agent_id !== afterOwner?.assigned_agent_id
  if (transfer.status === 200 && changed) {
    report('C1 · la transferencia cambia el titular', 'OK', 'el titular cambió')
  } else {
    report(
      'C1 · la transferencia cambia el titular',
      'PENDIENTE',
      `HTTP ${transfer.status}, titular antes=${beforeOwner?.assigned_agent_id ?? 'null'} ` +
        `después=${afterOwner?.assigned_agent_id ?? 'null'}`,
    )
  }

  // ¿Queda rastro de QUIÉN la hizo y POR QUÉ?
  const { count: historyRows } = await service
    .from('ticket_history')
    .select('id', { count: 'exact', head: true })
  const reasonAccepted = await call(adminToken, `/api/conversations/${convId}`, {
    method: 'PATCH',
    body: { assigned_agent_id: null, reason: 'prueba' },
  })
  const hasReason =
    reasonAccepted.status === 400
      ? 'el cuerpo NO acepta motivo (rechazado por el allowlist)'
      : 'el cuerpo acepta un campo extra, pero no queda registrado'

  if (historyRows === 0) {
    report(
      'C2 · la transferencia queda registrada (quién y por qué)',
      'PENDIENTE',
      `no existe bitácora de conversaciones (ticket_history=${historyRows} filas, ` +
        `que es de tickets): ${hasReason}.`,
    )
  } else {
    report(
      'C2 · la transferencia queda registrada (quién y por qué)',
      'PENDIENTE',
      `ticket_history tiene ${historyRows} filas, pero las conversaciones no ` +
        `tienen bitácora propia: ${hasReason}.`,
    )
  }

  // Limpieza: la conversación de validación no es parte de la semilla.
  await service.from('conversations').delete().eq('id', convId)

  const pending = results.filter((r) => r.verdict === 'PENDIENTE')
  console.log('')
  console.log('─────────────────────────────────────────────')
  console.log(`Controles verificados: ${results.length} · OK: ${results.length - pending.length} · PENDIENTE: ${pending.length}`)
  if (pending.length > 0) {
    console.log('')
    console.log('VEREDICTO: el entorno NO puede recibir datos reales todavía.')
    console.log('Controles pendientes:')
    for (const p of pending) console.log(`  · ${p.control}`)
    console.log('El entorno se mantiene con datos SINTÉTICOS.')
  } else {
    console.log('VEREDICTO: los controles verificados pasan.')
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exitCode = 1
})
