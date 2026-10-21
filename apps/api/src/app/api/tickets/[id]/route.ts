import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser, requirePermission } from '@/lib/auth'
import type { Permission } from '@/lib/permissions'
import { parseJson } from '@/lib/validate'
import { createSupabaseAdminClient } from '@/lib/supabase/admin'
import {
  updateTicket,
  findTicketOrThrow,
  trashTicket,
  TicketValidationError,
} from '@/services/tickets'

const TicketPatchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.unknown().optional(),
  assigned_to: z.string().uuid().nullable().optional(),
  theme_id: z.string().uuid().nullable().optional(),
  flow_id: z.string().uuid().nullable().optional(),
  category_id: z.string().uuid().optional(),
  /** C2: flag for the client ficha's "incidencias mayores". */
  is_major: z.boolean().optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  due_at: z.string().datetime().nullable().optional(),
})

type Params = { params: Promise<{ id: string }> }

export async function GET(_request: Request, ctx: Params) {
  const auth = await requirePermission(['ticket.read'], _request)
  if ('error' in auth) return auth.error
  const { id } = await ctx.params

  const admin = createSupabaseAdminClient()
  const { data, error } = await admin
    .from('tickets')
    .select('*')
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle()
  if (error) {
    return NextResponse.json(
      { code: 'db_error', error: 'db_error', message: error.message },
      { status: 500 },
    )
  }
  if (!data) {
    return NextResponse.json(
      { code: 'not_found', error: 'not_found', message: 'Ticket not found' },
      { status: 404 },
    )
  }
  return NextResponse.json({ data })
}

export async function PATCH(request: Request, ctx: Params) {
  const auth = await requireUser(request)
  if ('error' in auth) return auth.error
  const { id } = await ctx.params

  const parsed = await parseJson(request, TicketPatchBody)
  if ('error' in parsed) return parsed.error

  // The patch mixes fields with different power levels: renaming a ticket is
  // not the same act as reassigning it or moving it in the pipeline. Require
  // exactly the keys the body touches — asking for the union would let
  // someone who may only rename also reassign.
  const p = parsed.data
  const needed: Permission[] = []
  if (p.name !== undefined || p.description !== undefined) needed.push('ticket.update')
  if (p.assigned_to !== undefined) needed.push('ticket.assign')
  if (p.flow_id !== undefined) needed.push('ticket.moveFlow')
  if (p.category_id !== undefined) needed.push('category.update')
  if (p.theme_id !== undefined) needed.push('theme.create')
  // Marking a major incident is a triage judgement, not an edit: it feeds the
  // client ficha's escalation summary, so it needs its own gate.
  if (p.is_major !== undefined) needed.push('ticket.markMajor')
  if (needed.length === 0) needed.push('ticket.update')

  const held = auth.user.permissions
  const denied = needed.filter((perm) => !held.includes(perm))
  if (denied.length > 0) {
    return NextResponse.json(
      {
        code: 'forbidden',
        error: 'forbidden',
        message: `Requires permission: ${denied.join(', ')}`,
        required: denied,
      },
      { status: 403 },
    )
  }

  try {
    const updated = await updateTicket(id, parsed.data, auth.user.id)
    return NextResponse.json({ data: updated })
  } catch (err) {
    if (err instanceof TicketValidationError) {
      return NextResponse.json(
        { code: err.code, error: err.code, message: err.message },
        { status: err.status },
      )
    }
    const e = err as { code?: string; message?: string }
    if (e.code === '23503') {
      return NextResponse.json(
        { code: 'invalid_fk', error: 'invalid_fk', message: 'A referenced id does not exist' },
        { status: 400 },
      )
    }
    return NextResponse.json(
      { code: 'db_error', error: 'db_error', message: e.message ?? 'Unknown error' },
      { status: 500 },
    )
  }
}

/**
 * DELETE /api/tickets/:id — trash a ticket. Admin only (T4).
 *
 * Soft delete: the row survives with deleted_at/deleted_by set so the history
 * and conversation links are preserved. Restore via
 * POST /api/tickets/:id/restore.
 */
export async function DELETE(request: Request, ctx: Params) {
  const auth = await requirePermission(['ticket.delete'], request)
  if ('error' in auth) return auth.error
  const { id } = await ctx.params

  try {
    const ticket = await trashTicket(id, auth.user.id)
    return NextResponse.json({ data: ticket })
  } catch (err) {
    if (err instanceof TicketValidationError) {
      return NextResponse.json(
        { code: err.code, error: err.code, message: err.message },
        { status: err.status },
      )
    }
    return NextResponse.json(
      { code: 'db_error', error: 'db_error', message: (err as Error).message },
      { status: 500 },
    )
  }
}
