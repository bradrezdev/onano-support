import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { parseJson, getQuery } from '@/lib/validate'
import { createSupabaseAdminClient } from '@/lib/supabase/admin'
import { getContactDetail } from '@/services/contacts'

const ContactUpdate = z.object({
  name: z.string().min(1).max(200).optional(),
  email: z.string().email().nullable().optional(),
  country: z.string().min(2).max(80).nullable().optional(),
  country_code: z.string().length(2).nullable().optional(),
  profile_pic_url: z.string().url().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

type Params = { params: Promise<{ id: string }> }

/**
 * GET /api/contacts/:id — the client's record.
 *
 * With `?detail=1` it returns the full ficha (C2): the tickets assigned to
 * this client, the ones flagged as major incidents, the conversation history
 * with the themes each ticket touched. Four queries in parallel, scoped to
 * the one contact, rather than the client downloading the whole ticket list
 * and filtering it in the browser.
 */
export async function GET(request: Request, ctx: Params) {
  const auth = await requirePermission(['contact.read'], request)
  if ('error' in auth) return auth.error
  const { id } = await ctx.params

  const q = getQuery<{ detail?: boolean }>(request, {
    detail: (v) => v === '1' || v === 'true',
  })

  if (q.detail) {
    try {
      const detail = await getContactDetail(id)
      if (!detail) {
        return NextResponse.json(
          { code: 'not_found', error: 'not_found', message: 'Contact not found' },
          { status: 404 },
        )
      }
      return NextResponse.json({ data: detail })
    } catch (err) {
      return NextResponse.json(
        { code: 'db_error', error: 'db_error', message: (err as Error).message },
        { status: 500 },
      )
    }
  }

  const admin = createSupabaseAdminClient()
  const { data, error } = await admin
    .from('contacts')
    .select('id, whatsapp_number, name, email, country, country_code, profile_pic_url, metadata, created_at, updated_at')
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
      { code: 'not_found', error: 'not_found', message: 'Contact not found' },
      { status: 404 },
    )
  }
  return NextResponse.json({ data })
}

export async function PATCH(request: Request, ctx: Params) {
  const auth = await requirePermission(['contact.update'], request)
  if ('error' in auth) return auth.error
  const { id } = await ctx.params

  const parsed = await parseJson(request, ContactUpdate)
  if ('error' in parsed) return parsed.error
  const body = parsed.data

  const admin = createSupabaseAdminClient()
  const patch: Record<string, unknown> = { ...body }
  if ('country_code' in patch && patch.country_code) {
    patch.country_code = String(patch.country_code).toUpperCase()
  }
  const { data, error } = await admin
    .from('contacts')
    .update(patch)
    .eq('id', id)
    .is('deleted_at', null)
    .select('id, whatsapp_number, name, email, country, country_code, profile_pic_url, created_at, updated_at')
    .single()

  if (error) {
    return NextResponse.json(
      { code: 'db_error', error: 'db_error', message: error.message },
      { status: 500 },
    )
  }
  if (!data) {
    return NextResponse.json(
      { code: 'not_found', error: 'not_found', message: 'Contact not found' },
      { status: 404 },
    )
  }
  return NextResponse.json({ data })
}

export async function DELETE(request: Request, ctx: Params) {
  const auth = await requirePermission(['contact.delete'], request)
  if ('error' in auth) return auth.error
  const { id } = await ctx.params

  const admin = createSupabaseAdminClient()
  const { error, count } = await admin
    .from('contacts')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .is('deleted_at', null)

  if (error) {
    return NextResponse.json(
      { code: 'db_error', error: 'db_error', message: error.message },
      { status: 500 },
    )
  }
  if (!count) {
    return NextResponse.json(
      { code: 'not_found', error: 'not_found', message: 'Contact not found' },
      { status: 404 },
    )
  }
  return new NextResponse(null, { status: 204 })
}