import { createSupabaseAdminClient } from '@/lib/supabase/admin'
import { sanitizeTipTap, extractPlainText } from '@/lib/sanitize'

export interface Ticket {
  id: string
  contact_id: string
  category_id: string
  assigned_to: string | null
  theme_id: string | null
  flow_id: string | null
  name: string
  description: unknown
  description_plain: string
  status: 'open' | 'in_progress' | 'closed'
  created_by: string
  closed_by: string | null
  closed_at: string | null
  reopened_by: string | null
  reopened_at: string | null
  created_at: string
  updated_at: string
}

export interface TicketCreateInput {
  contact_id: string
  category_id: string
  name: string
  description: unknown
  assigned_to?: string | null
  theme_id?: string | null
  flow_id?: string | null
}

export class TicketValidationError extends Error {
  status: number
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.status = 400
  }
}

export async function createTicket(input: TicketCreateInput, actorId: string): Promise<Ticket> {
  const doc = sanitizeTipTap(input.description)
  if (!doc) {
    throw new TicketValidationError('invalid_description', 'description must be a TipTap doc')
  }
  const plain = extractPlainText(doc)
  if (!plain) {
    throw new TicketValidationError('empty_description', 'description cannot be empty')
  }

  const admin = createSupabaseAdminClient()
  const { data, error } = await admin
    .from('tickets')
    .insert({
      contact_id: input.contact_id,
      category_id: input.category_id,
      name: input.name.trim(),
      description: doc,
      description_plain: plain,
      assigned_to: input.assigned_to ?? null,
      theme_id: input.theme_id ?? null,
      flow_id: input.flow_id ?? null,
      status: 'open',
      created_by: actorId,
    })
    .select('*')
    .single<Ticket>()

  if (error) throw error
  if (!data) throw new Error('insert returned no row')

  await admin.from('ticket_history').insert({
    ticket_id: data.id,
    actor_id: actorId,
    action: 'created',
    to_value: { name: data.name, contact_id: data.contact_id, category_id: data.category_id },
  })

  return data
}

export async function findTicketOrThrow(id: string): Promise<Ticket> {
  const admin = createSupabaseAdminClient()
  const { data, error } = await admin
    .from('tickets')
    .select('*')
    .eq('id', id)
    .maybeSingle<Ticket>()
  if (error) throw error
  if (!data) throw new TicketValidationError('not_found', 'Ticket not found')
  return data
}

export async function updateTicket(
  id: string,
  patch: {
    name?: string
    description?: unknown
    assigned_to?: string | null
    theme_id?: string | null
    flow_id?: string | null
    category_id?: string
  },
  actorId: string,
): Promise<Ticket> {
  const before = await findTicketOrThrow(id)
  const admin = createSupabaseAdminClient()
  const update: Record<string, unknown> = {}
  if (patch.name !== undefined) update.name = patch.name.trim()
  if (patch.description !== undefined) {
    const doc = sanitizeTipTap(patch.description)
    if (!doc) throw new TicketValidationError('invalid_description', 'description must be a TipTap doc')
    const plain = extractPlainText(doc)
    if (!plain) throw new TicketValidationError('empty_description', 'description cannot be empty')
    update.description = doc
    update.description_plain = plain
  }
  if (patch.assigned_to !== undefined) update.assigned_to = patch.assigned_to
  if (patch.theme_id !== undefined) update.theme_id = patch.theme_id
  if (patch.flow_id !== undefined) update.flow_id = patch.flow_id
  if (patch.category_id !== undefined) update.category_id = patch.category_id

  const { data, error } = await admin
    .from('tickets')
    .update(update)
    .eq('id', id)
    .select('*')
    .single<Ticket>()
  if (error) throw error
  if (!data) throw new Error('update returned no row')

  const events: Array<{ action: string; from: unknown; to: unknown }> = []
  if (patch.assigned_to !== undefined && before.assigned_to !== patch.assigned_to) {
    events.push({ action: patch.assigned_to ? 'assigned' : 'reassigned', from: before.assigned_to, to: patch.assigned_to })
  }
  if (patch.theme_id !== undefined && before.theme_id !== patch.theme_id) {
    events.push({ action: 'theme_changed', from: before.theme_id, to: patch.theme_id })
  }
  if (patch.flow_id !== undefined && before.flow_id !== patch.flow_id) {
    events.push({ action: 'flow_changed', from: before.flow_id, to: patch.flow_id })
  }
  if (patch.category_id !== undefined && before.category_id !== patch.category_id) {
    events.push({ action: 'category_changed', from: before.category_id, to: patch.category_id })
  }

  if (events.length > 0) {
    await admin.from('ticket_history').insert(
      events.map((e) => ({
        ticket_id: id,
        actor_id: actorId,
        action: e.action,
        from_value: e.from ?? null,
        to_value: e.to ?? null,
      })),
    )
  }

  return data
}

export async function moveTicket(id: string, flowId: string | null, actorId: string): Promise<Ticket> {
  const before = await findTicketOrThrow(id)
  if (before.status === 'closed') {
    throw new TicketValidationError('ticket_closed', 'Cannot move a closed ticket')
  }
  const admin = createSupabaseAdminClient()
  const { data, error } = await admin
    .from('tickets')
    .update({ flow_id: flowId })
    .eq('id', id)
    .select('*')
    .single<Ticket>()
  if (error) throw error
  if (!data) throw new Error('move returned no row')

  await admin.from('ticket_history').insert({
    ticket_id: id,
    actor_id: actorId,
    action: 'flow_changed',
    from_value: before.flow_id,
    to_value: flowId,
  })
  return data
}

export async function closeTicket(id: string, actorId: string): Promise<Ticket> {
  const before = await findTicketOrThrow(id)
  if (before.status === 'closed') {
    throw new TicketValidationError('already_closed', 'Ticket already closed')
  }
  const admin = createSupabaseAdminClient()
  const now = new Date().toISOString()
  const { data, error } = await admin
    .from('tickets')
    .update({ status: 'closed', closed_by: actorId, closed_at: now })
    .eq('id', id)
    .select('*')
    .single<Ticket>()
  if (error) throw error
  if (!data) throw new Error('close returned no row')

  await admin.from('ticket_history').insert({
    ticket_id: id,
    actor_id: actorId,
    action: 'closed',
    from_value: { status: before.status },
    to_value: { status: 'closed' },
  })
  return data
}

export async function reopenTicket(id: string, actorId: string): Promise<Ticket> {
  const before = await findTicketOrThrow(id)
  if (before.status !== 'closed') {
    throw new TicketValidationError('not_closed', 'Ticket is not closed')
  }
  const admin = createSupabaseAdminClient()
  const now = new Date().toISOString()
  const { data, error } = await admin
    .from('tickets')
    .update({ status: 'open', reopened_by: actorId, reopened_at: now, closed_by: null, closed_at: null })
    .eq('id', id)
    .select('*')
    .single<Ticket>()
  if (error) throw error
  if (!data) throw new Error('reopen returned no row')

  await admin.from('ticket_history').insert({
    ticket_id: id,
    actor_id: actorId,
    action: 'reopened',
    from_value: { status: 'closed' },
    to_value: { status: 'open' },
  })
  return data
}