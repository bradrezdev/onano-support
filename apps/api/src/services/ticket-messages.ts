import { createSupabaseAdminClient } from '@/lib/supabase/admin'
import { sanitizeTipTap } from '@/lib/sanitize'

export interface TicketMessage {
  id: string
  ticket_id: string
  author_id: string
  body: unknown
  body_plain: string
  role_at_send: 'admin' | 'supervisor' | 'soporte'
  fade_step: number
  created_at: string
}

export interface RoleColorSetting {
  role: 'admin' | 'supervisor' | 'soporte'
  base_color: string
  fade_steps: number
}

export class TicketMessageError extends Error {
  status: number
  code: string
  constructor(code: string, message: string, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

export async function listTicketMessages(ticketId: string): Promise<TicketMessage[]> {
  const admin = createSupabaseAdminClient()
  const { data, error } = await admin
    .from('ticket_messages')
    .select('id, ticket_id, author_id, body, body_plain, role_at_send, fade_step, created_at')
    .eq('ticket_id', ticketId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data ?? []) as unknown as TicketMessage[]
}

function extractPlainText(json: unknown): string {
  function walk(node: unknown): string {
    if (typeof node === 'string') return node
    if (!node || typeof node !== 'object') return ''
    const n = node as { text?: string; content?: unknown[] }
    if (typeof n.text === 'string') return n.text
    if (Array.isArray(n.content)) return n.content.map(walk).join('')
    return ''
  }
  return walk(json).replace(/\s+/g, ' ').trim()
}

export async function createTicketMessage(
  ticketId: string,
  body: unknown,
  authorId: string,
  authorRole: 'admin' | 'supervisor' | 'soporte',
): Promise<TicketMessage> {
  const doc = sanitizeTipTap(body)
  const plain = extractPlainText(doc)
  if (!plain) {
    throw new TicketMessageError(
      'empty_body',
      'El cuerpo del mensaje está vacío',
    )
  }

  const admin = createSupabaseAdminClient()
  const [{ data: ticket, error: tErr }, { data: lastByRole, error: lastErr }] =
    await Promise.all([
      admin
        .from('tickets')
        .select('id, status')
        .eq('id', ticketId)
        .maybeSingle<{ id: string; status: 'open' | 'in_progress' | 'closed' }>(),
      admin
        .from('ticket_messages')
        .select('fade_step')
        .eq('ticket_id', ticketId)
        .eq('role_at_send', authorRole)
        .order('created_at', { ascending: false })
        .limit(1),
    ])
  if (tErr) throw tErr
  if (!ticket) {
    throw new TicketMessageError('ticket_not_found', 'Ticket no encontrado', 404)
  }
  if (ticket.status === 'closed') {
    throw new TicketMessageError(
      'ticket_closed',
      'El ticket está cerrado',
      409,
    )
  }
  if (lastErr) throw lastErr
  const last = ((lastByRole ?? []) as { fade_step: number }[])[0]
  const fadeStep = last ? Math.min(last.fade_step + 1, 9) : 0

  const { data, error } = await admin
    .from('ticket_messages')
    .insert({
      ticket_id: ticketId,
      author_id: authorId,
      body: doc,
      body_plain: plain,
      role_at_send: authorRole,
      fade_step: fadeStep,
    })
    .select('id, ticket_id, author_id, body, body_plain, role_at_send, fade_step, created_at')
    .single<TicketMessage>()
  if (error) throw error
  return data
}

export async function listRoleColors(): Promise<RoleColorSetting[]> {
  const admin = createSupabaseAdminClient()
  const { data, error } = await admin
    .from('role_color_settings')
    .select('role, base_color, fade_steps')
    .order('role', { ascending: true })
  if (error) throw error
  return (data ?? []) as unknown as RoleColorSetting[]
}

export async function upsertRoleColor(
  role: RoleColorSetting['role'],
  baseColor: string,
  fadeSteps: number,
  actorId: string,
): Promise<RoleColorSetting> {
  if (!/^#[0-9a-fA-F]{6}$/.test(baseColor)) {
    throw new TicketMessageError(
      'invalid_color',
      'Color debe ser #RRGGBB',
    )
  }
  if (fadeSteps < 1 || fadeSteps > 10 || !Number.isInteger(fadeSteps)) {
    throw new TicketMessageError(
      'invalid_fade_steps',
      'fade_steps debe ser entero entre 1 y 10',
    )
  }
  const admin = createSupabaseAdminClient()
  const { data, error } = await admin
    .from('role_color_settings')
    .upsert(
      {
        role,
        base_color: baseColor,
        fade_steps: fadeSteps,
        updated_by: actorId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'role' },
    )
    .select('role, base_color, fade_steps')
    .single<RoleColorSetting>()
  if (error) throw error
  return data
}