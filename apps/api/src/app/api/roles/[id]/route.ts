import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { parseJson } from '@/lib/validate'
import { updateRole, deleteRole, RoleValidationError } from '@/services/roles'

type Params = { params: Promise<{ id: string }> }

const RolePatchBody = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(300).nullish(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  permissions: z.array(z.string()).optional(),
})

/**
 * PATCH /api/roles/:id — edit name, color and keyring.
 *
 * The `key` is deliberately NOT editable: profiles and role_color_settings
 * reference it by slug, and renaming it would silently orphan both.
 */
export async function PATCH(request: Request, ctx: Params) {
  const auth = await requirePermission(['admin.manageRoles'], request)
  if ('error' in auth) return auth.error
  const { id } = await ctx.params

  const parsed = await parseJson(request, RolePatchBody)
  if ('error' in parsed) return parsed.error

  try {
    const role = await updateRole(
      id,
      {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.description !== undefined
          ? { description: parsed.data.description ?? null }
          : {}),
        ...(parsed.data.color !== undefined ? { color: parsed.data.color } : {}),
        ...(parsed.data.permissions !== undefined
          ? { permissions: parsed.data.permissions as never[] }
          : {}),
      },
      auth.user.id,
    )
    return NextResponse.json({ data: role })
  } catch (err) {
    if (err instanceof RoleValidationError) {
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

/** DELETE /api/roles/:id — remove a custom role. Admin only, and only if unused. */
export async function DELETE(request: Request, ctx: Params) {
  const auth = await requirePermission(['admin.manageRoles'], request)
  if ('error' in auth) return auth.error
  const { id } = await ctx.params

  try {
    await deleteRole(id)
    return NextResponse.json({ deleted: true })
  } catch (err) {
    if (err instanceof RoleValidationError) {
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