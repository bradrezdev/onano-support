import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireRole } from '@/lib/auth'
import { parseJson } from '@/lib/validate'
import { createSupabaseAdminClient } from '@/lib/supabase/admin'
import { updateTicket, findTicketOrThrow, TicketValidationError } from '@/services/tickets'

const TicketPatchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.unknown().optional(),
  assigned_to: z.string().uuid().nullable().optional(),
  theme_id: z.string().uuid().nullable().optional(),
  flow_id: z.string().uuid().nullable().optional(),
  category_id: z.string().uuid().optional(),
})

type Params = { params: Promise<{ id: string }> }

export async function GET(_request: Request, ctx: Params) {
  const auth = await requireRole(['admin', 'supervisor', 'soporte'], _request)
  if ('error' in auth) return auth.error
  const { id } = await ctx.params

  const admin = createSupabaseAdminClient()
  const { data, error } = await admin
    .from('tickets')
    .select('*')
    .eq('id', id)
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
  const auth = await requireRole(['admin', 'supervisor', 'soporte'], request)
  if ('error' in auth) return auth.error
  const { id } = await ctx.params

  const parsed = await parseJson(request, TicketPatchBody)
  if ('error' in parsed) return parsed.error

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