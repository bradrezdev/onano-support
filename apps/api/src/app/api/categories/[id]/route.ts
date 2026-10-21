import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { parseJson } from '@/lib/validate'
import { createSupabaseAdminClient } from '@/lib/supabase/admin'
import { categoryHasChildren, findCategoryById } from '@/services/categories'

const CategoryUpdate = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
})

type Params = { params: Promise<{ id: string }> }

export async function PATCH(request: Request, ctx: Params) {
  const auth = await requirePermission(['category.update'], request)
  if ('error' in auth) return auth.error
  const { id } = await ctx.params

  const parsed = await parseJson(request, CategoryUpdate)
  if ('error' in parsed) return parsed.error
  const body = parsed.data

  const existing = await findCategoryById(id)
  if (!existing) {
    return NextResponse.json(
      { code: 'not_found', error: 'not_found', message: 'Category not found' },
      { status: 404 },
    )
  }

  const admin = createSupabaseAdminClient()
  const { data, error } = await admin
    .from('categories')
    .update({
      ...(body.name !== undefined ? { name: body.name.trim() } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
    })
    .eq('id', id)
    .select('id, parent_id, name, description, created_by, created_at, updated_at')
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json(
        { code: 'duplicate', error: 'duplicate', message: 'A category with that name already exists at this level' },
        { status: 409 },
      )
    }
    return NextResponse.json(
      { code: 'db_error', error: 'db_error', message: error.message },
      { status: 500 },
    )
  }
  return NextResponse.json({ data })
}

export async function DELETE(request: Request, ctx: Params) {
  const auth = await requirePermission(['category.delete'], request)
  if ('error' in auth) return auth.error
  const { id } = await ctx.params

  const hasChildren = await categoryHasChildren(id)
  if (hasChildren) {
    return NextResponse.json(
      {
        code: 'has_children',
        error: 'has_children',
        message: 'Delete sub-categories first',
      },
      { status: 409 },
    )
  }

  const admin = createSupabaseAdminClient()
  const { error } = await admin.from('categories').delete().eq('id', id)
  if (error) {
    return NextResponse.json(
      { code: 'db_error', error: 'db_error', message: error.message },
      { status: 500 },
    )
  }
  return new NextResponse(null, { status: 204 })
}
