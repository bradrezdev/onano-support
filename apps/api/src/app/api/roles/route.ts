import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { parseJson } from '@/lib/validate'
import { PERMISSION_CATALOG } from '@/lib/permissions'
import { listRoles, createRole, RoleValidationError } from '@/services/roles'

/**
 * GET /api/roles — list roles with their keyrings.
 *
 * Any authenticated user may read this: the SPA needs to know which role a
 * person has in order to render anything at all. It exposes no personal data
 * beyond role metadata.
 */
export async function GET(request: Request) {
  const auth = await requirePermission(['conversation.read'], request)
  if ('error' in auth) return auth.error

  try {
    return NextResponse.json({
      data: await listRoles(),
      catalog: PERMISSION_CATALOG,
    })
  } catch (err) {
    return NextResponse.json(
      { code: 'db_error', error: 'db_error', message: (err as Error).message },
      { status: 500 },
    )
  }
}

const RoleCreateBody = z.object({
  key: z.string().min(2).max(31),
  name: z.string().min(1).max(80),
  description: z.string().max(300).nullish(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color must be #rrggbb'),
  permissions: z.array(z.string()).default([]),
})

/**
 * POST /api/roles — create a custom role. Requires admin.manageRoles.
 *
 * Creating a role with an empty keyring is allowed on purpose: it shows up as
 * a blank badge the Admin can then fill in, instead of failing silently later.
 */
export async function POST(request: Request) {
  const auth = await requirePermission(['admin.manageRoles'], request)
  if ('error' in auth) return auth.error

  const parsed = await parseJson(request, RoleCreateBody)
  if ('error' in parsed) return parsed.error

  try {
    const role = await createRole(
      {
        key: parsed.data.key,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        color: parsed.data.color,
        permissions: parsed.data.permissions as never[],
      },
      auth.user.id,
    )
    return NextResponse.json({ data: role }, { status: 201 })
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