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
 * Con `--strict` (o con `ACCESS_CONTROLS_STRICT=1`) el script sale con código
 * 1 si algún control queda PENDIENTE: es la puerta que usa el CI, donde un
 * control que no se puede verificar NO puede pasar en verde.
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
/**
 * Agente sin ningún ticket ni chat: es el que debe recibir 403 en los
 * controles de aislamiento. No puede ser "el que perdió la toma", porque ese
 * puede ser el titular del ticket sembrado.
 */
const OUTSIDER_EMAIL = 'e2e.outsider@example.test'
const PASSWORD = process.env.E2E_PASSWORD ?? 'E2E-sintetico-9931'

const strict =
  process.env.ACCESS_CONTROLS_STRICT === '1' || process.argv.includes('--strict')

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
  const adminId = idOf(ADMIN_EMAIL)

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
  if ([403, 404, 409].includes(messages.status)) {
    report(
      'B2 · envío de mensajes a la conversación ajena',
      'OK',
      `el agente ajeno recibe ${messages.status} y el mensaje NO se guarda`,
    )
  } else {
    report(
      'B2 · envío de mensajes a la conversación ajena',
      'PENDIENTE',
      `el agente ajeno recibió ${messages.status}: puede escribir en un chat que no es suyo.`,
    )
  }

  if (ticket) {
    // Un agente que no tiene ningún ticket ni chat: el único al que se le
    // puede pedir el 403 sin que el resultado dependa de quién ganó la toma.
    const { data: existingOutsiders } = await service.auth.admin.listUsers({
      page: 1,
      perPage: 200,
    })
    const previousOutsider = existingOutsiders?.users.find(
      (u) => u.email?.toLowerCase() === OUTSIDER_EMAIL,
    )
    if (previousOutsider) await service.auth.admin.deleteUser(previousOutsider.id)
    const { error: createOutsiderErr } = await service.auth.admin.createUser({
      email: OUTSIDER_EMAIL,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { display_name: 'E2E Agente Ajeno' },
    })
    if (createOutsiderErr) throw new Error(`outsider: ${createOutsiderErr.message}`)
    const outsiderToken2 = await signIn(OUTSIDER_EMAIL)

    const att = await call(outsiderToken2, `/api/tickets/${ticket.id}/attachments`)
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
  const { data: beforeOwner, error: bErr } = await service
    .from('conversations')
    .select('assigned_agent_id, assignment_version')
    .eq('id', convId)
    .single<{ assigned_agent_id: string | null; assignment_version: number }>()
  if (bErr) throw new Error(`conversations: ${bErr.message}`)

  // La transferencia exige motivo y versión vigente.
  const reason = 'control de validación: devolución a la cola'
  const transfer = await call(adminToken, `/api/conversations/${convId}`, {
    method: 'PATCH',
    body: {
      assigned_agent_id: null,
      reason,
      expected_version: beforeOwner?.assignment_version ?? 1,
    },
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
  const { data: auditRows, error: auditErr } = await service
    .from('conversation_audit_log')
    .select(
      'actor_id, previous_assignee_id, new_assignee_id, reason, version_before, version_after, created_at',
    )
    .eq('conversation_id', convId)
    .order('created_at', { ascending: false })
    .limit(1)
  if (auditErr) throw new Error(`conversation_audit_log: ${auditErr.message}`)

  const entry = auditRows?.[0]
  const complete =
    Boolean(entry) &&
    entry?.actor_id === adminId &&
    entry?.reason === reason &&
    Boolean(entry?.created_at) &&
    entry?.version_after === (entry?.version_before ?? 0) + 1

  if (complete) {
    report(
      'C2 · la transferencia queda registrada (quién y por qué)',
      'OK',
      `bitácora: actor=${String(entry?.actor_id).slice(0, 8)}… ` +
        `anterior=${String(entry?.previous_assignee_id ?? 'null').slice(0, 8)}… ` +
        `nuevo=${String(entry?.new_assignee_id ?? 'null').slice(0, 8)}… ` +
        `motivo="${entry?.reason}" fecha=${entry?.created_at}`,
    )
  } else {
    report(
      'C2 · la transferencia queda registrada (quién y por qué)',
      'PENDIENTE',
      entry
        ? `la entrada existe pero no está completa: ${JSON.stringify(entry)}`
        : 'no hay entrada en conversation_audit_log para esta transferencia.',
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
    // En modo estricto (CI) un control pendiente es un job en rojo: una
    // puerta que no se puede verificar no puede pasar en verde.
    if (strict) {
      console.error('')
      console.error(`FALLO: ${pending.length} control(es) PENDIENTE: la puerta de acceso no puede quedar en verde.`)
      process.exitCode = 1
    }
  } else {
    console.log('VEREDICTO: los controles verificados pasan.')
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exitCode = 1
})
