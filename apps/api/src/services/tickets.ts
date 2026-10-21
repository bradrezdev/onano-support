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
  deleted_at: string | null
  deleted_by: string | null
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

/**
 * Loads a ticket by id, rejecting trashed rows unless `includeTrashed`.
 * Every mutation path goes through here, so a trashed ticket cannot be
 * replied to, reassigned or closed by accident.
 */
export async function findTicketOrThrow(
  id: string,
  opts: { includeTrashed?: boolean } = {},
): Promise<Ticket> {
  const admin = createSupabaseAdminClient()
  let q = admin.from('tickets').select('*').eq('id', id)
  if (!opts.includeTrashed) q = q.is('deleted_at', null)
  const { data, error } = await q.maybeSingle<Ticket>()
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
    is_major?: boolean
    priority?: 'low' | 'normal' | 'high' | 'urgent'
    due_at?: string | null
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
  if (patch.is_major !== undefined) update.is_major = patch.is_major
  if (patch.priority !== undefined) update.priority = patch.priority
  if (patch.due_at !== undefined) update.due_at = patch.due_at

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

  // Recommendation 2: "cerrado" and "the phase" are one idea, not two.
  // Closing snaps the ticket to the pipeline's terminal phase. Otherwise a
  // closed ticket keeps sitting in "En revisión", which is the exact
  // contradiction the recommendation warns about.
  //
  // The snap only applies when the project actually defines a terminal phase.
  // A ticket with no flow, or a project whose last phase is not marked
  // terminal, closes normally — inventing a phase here would be worse than
  // the ambiguity we are removing.
  let flowPatch: Record<string, unknown> = {}
  if (before.flow_id) {
    const { data: flow, error: fErr } = await admin
      .from('flows')
      .select('theme_id')
      .eq('id', before.flow_id)
      .maybeSingle<{ theme_id: string }>()
    if (fErr) throw fErr

    if (flow?.theme_id) {
      // Highest-position terminal phase is the destination.
      const { data: terminal, error: tErr } = await admin
        .from('flows')
        .select('id')
        .eq('theme_id', flow.theme_id)
        .eq('is_terminal', true)
        .order('position', { ascending: false })
        .limit(1)
        .maybeSingle<{ id: string }>()
      if (tErr) throw tErr
      if (terminal) {
        flowPatch = { flow_id: terminal.id }
      }
    }
  }

  const now = new Date().toISOString()
  const { data, error } = await admin
    .from('tickets')
    .update({ status: 'closed', closed_by: actorId, closed_at: now, ...flowPatch })
    .eq('id', id)
    .select('*')
    .single<Ticket>()
  if (error) throw error
  if (!data) throw new Error('close returned no row')

  await admin.from('ticket_history').insert({
    ticket_id: id,
    actor_id: actorId,
    action: 'closed',
    from_value: { status: before.status, flow_id: before.flow_id },
    to_value: { status: 'closed', flow_id: data.flow_id },
  })
  return data
}

export async function reopenTicket(id: string, actorId: string): Promise<Ticket> {
  const before = await findTicketOrThrow(id)
  if (before.status !== 'closed') {
    throw new TicketValidationError('not_closed', 'Ticket is not closed')
  }
  const admin = createSupabaseAdminClient()

  // Mirror image of close: a reopened ticket must not sit in the terminal
  // phase, or "reabierto" and "terminado" contradict each other exactly the
  // way the recommendation describes. Drop it to the first non-terminal phase.
  let flowPatch: Record<string, unknown> = {}
  if (before.flow_id) {
    const { data: flow } = await admin
      .from('flows')
      .select('theme_id')
      .eq('id', before.flow_id)
      .maybeSingle<{ theme_id: string }>()

    if (flow?.theme_id) {
      const { data: first } = await admin
        .from('flows')
        .select('id')
        .eq('theme_id', flow.theme_id)
        .eq('is_terminal', false)
        .order('position', { ascending: true })
        .limit(1)
        .maybeSingle<{ id: string }>()
      if (first) {
        flowPatch = { flow_id: first.id }
      }
    }
  }

  const now = new Date().toISOString()
  const { data, error } = await admin
    .from('tickets')
    .update({
      status: 'open',
      reopened_by: actorId,
      reopened_at: now,
      closed_by: null,
      closed_at: null,
      ...flowPatch,
    })
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

/**
 * Soft delete ("papelera en vez de borrar"). The row survives so ticket_history
 * and conversation_tickets keep their references and an Admin can see who
 * trashed it. `status` is intentionally untouched: the trash is a separate
 * axis from open/in_progress/closed.
 */
export async function trashTicket(id: string, actorId: string): Promise<Ticket> {
  const before = await findTicketOrThrow(id)
  const admin = createSupabaseAdminClient()
  const { data, error } = await admin
    .from('tickets')
    .update({ deleted_at: new Date().toISOString(), deleted_by: actorId })
    .eq('id', id)
    .is('deleted_at', null)
    .select('*')
    .single<Ticket>()
  if (error) throw error
  if (!data) throw new TicketValidationError('already_trashed', 'Ticket is already in the trash')

  await admin.from('ticket_history').insert({
    ticket_id: id,
    actor_id: actorId,
    action: 'trashed',
    from_value: null,
    to_value: { deleted_at: data.deleted_at },
  })
  return before
}

/** Bring a trashed ticket back. Admin only (route guard). */
export async function restoreTicket(id: string, actorId: string): Promise<Ticket> {
  const admin = createSupabaseAdminClient()
  const { data, error } = await admin
    .from('tickets')
    .update({ deleted_at: null, deleted_by: null })
    .eq('id', id)
    .not('deleted_at', 'is', null)
    .select('*')
    .single<Ticket>()
  if (error) throw error
  if (!data) throw new TicketValidationError('not_trashed', 'Ticket is not in the trash')

  await admin.from('ticket_history').insert({
    ticket_id: id,
    actor_id: actorId,
    action: 'restored',
    from_value: null,
    to_value: { deleted_at: null },
  })
  return data
}