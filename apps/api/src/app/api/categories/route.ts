import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { parseJson, getQuery } from '@/lib/validate'
import { createSupabaseAdminClient } from '@/lib/supabase/admin'
import { listCategoryTree, findCategoryById } from '@/services/categories'

const CategoryCreate = z.object({
  name: z.string().min(1).max(120),
  parent_id: z.string().uuid().nullable().optional(),
  description: z.string().max(500).nullable().optional(),
})

export async function GET(request: Request) {
  const auth = await requirePermission(['conversation.read'], request)
  if ('error' in auth) return auth.error

  const q = getQuery<{ flat?: boolean }>(request, {
    flat: (v) => v === '1' || v === 'true',
  })

  if (q.flat) {
    const admin = createSupabaseAdminClient()
    const { data, error } = await admin
      .from('categories')
      .select('id, parent_id, name, description, created_by, created_at, updated_at')
      .order('name', { ascending: true })
    if (error) {
      return NextResponse.json(
        { code: 'db_error', error: 'db_error', message: error.message },
        { status: 500 },
      )
    }
    return NextResponse.json({ data: data ?? [] })
  }

  const tree = await listCategoryTree()
  return NextResponse.json({ data: tree })
}

export async function POST(request: Request) {
  const auth = await requirePermission(['category.create'], request)
  if ('error' in auth) return auth.error

  const parsed = await parseJson(request, CategoryCreate)
  if ('error' in parsed) return parsed.error
  const body = parsed.data

  if (body.parent_id) {
    const parent = await findCategoryById(body.parent_id)
    if (!parent) {
      return NextResponse.json(
        { code: 'invalid_parent', error: 'invalid_parent', message: 'parent_id not found' },
        { status: 400 },
      )
    }
    if (parent.parent_id) {
      // Two-level limit: a sub-category cannot have its own children.
      return NextResponse.json(
        { code: 'too_deep', error: 'too_deep', message: 'Sub-categories cannot have their own children' },
        { status: 400 },
      )
    }
  }

  const admin = createSupabaseAdminClient()
  const { data, error } = await admin
    .from('categories')
    .insert({
      name: body.name.trim(),
      parent_id: body.parent_id ?? null,
      description: body.description ?? null,
      created_by: auth.user.id,
    })
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
  return NextResponse.json({ data }, { status: 201 })
}
