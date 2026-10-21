import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { parseJson } from '@/lib/validate'
import {
  listRoleColors,
  upsertRoleColor,
  TicketMessageError,
} from '@/services/ticket-messages'

const Role = z.enum(['admin', 'supervisor', 'soporte'])
const ColorPut = z.object({
  base_color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  fade_steps: z.number().int().min(1).max(10),
})

export async function GET(request: Request) {
  const auth = await requirePermission(['conversation.read'], request)
  if ('error' in auth) return auth.error
  try {
    const data = await listRoleColors()
    return NextResponse.json({ data })
  } catch (err) {
    return NextResponse.json(
      { code: 'db_error', error: 'db_error', message: (err as Error).message },
      { status: 500 },
    )
  }
}

export async function PUT(request: Request) {
  const auth = await requirePermission(['admin.manageRoles'], request)
  if ('error' in auth) return auth.error
  // body carries { role, base_color, fade_steps }
  const BodyWithRole = ColorPut.extend({ role: Role })
  const parsed = await parseJson(request, BodyWithRole)
  if ('error' in parsed) return parsed.error
  try {
    const data = await upsertRoleColor(
      parsed.data.role,
      parsed.data.base_color,
      parsed.data.fade_steps,
      auth.user.id,
    )
    return NextResponse.json({ data })
  } catch (err) {
    if (err instanceof TicketMessageError) {
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
