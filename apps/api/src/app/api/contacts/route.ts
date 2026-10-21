import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { parseJson, getQuery } from '@/lib/validate'
import { normalizePhone, isLikelyWhatsapp } from '@/lib/phone'
import { createSupabaseAdminClient } from '@/lib/supabase/admin'

const ContactCreate = z.object({
  whatsapp_number: z.string().min(8).max(20),
  name: z.string().min(1).max(200),
  email: z.string().email().optional().nullable(),
  country: z.string().min(2).max(80).optional().nullable(),
  country_code: z.string().length(2).optional().nullable(),
  profile_pic_url: z.string().url().optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export async function GET(request: Request) {
  const auth = await requirePermission(['contact.read'], request)
  if ('error' in auth) return auth.error

  const q = getQuery<{
    q?: string
    country?: string
    page?: number
    limit?: number
  }>(request, {
    page: (v) => Math.max(1, parseInt(v, 10) || 1),
    limit: (v) => Math.min(100, Math.max(1, parseInt(v, 10) || 50)),
  })

  const page = q.page ?? 1
  const limit = q.limit ?? 50

  const admin = createSupabaseAdminClient()
  let query = admin
    .from('contacts')
    .select('id, whatsapp_number, name, email, country, country_code, profile_pic_url, created_at, updated_at')
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1)

  if (q.q && q.q.trim()) {
    // C3: search across name, phone and email.
    //
    // Phone is the identifying field (recommendation 15: "usando el teléfono
    // como identificador"), so a digit string must find the contact even when
    // the name does not contain it. The term is also normalised to E.164 when
    // it looks like a phone, so "+1 555 0100" matches "+15550100" — otherwise
    // the same person becomes two records because of formatting.
    const term = q.q.trim()
    const e164 = isLikelyWhatsapp(term) ? normalizePhone(term) : null
    const orFilter = e164
      ? `name.ilike.%${term}%,whatsapp_number.ilike.%${e164}%,email.ilike.%${term}%`
      : `name.ilike.%${term}%,whatsapp_number.ilike.%${term}%,email.ilike.%${term}%`
    query = query.or(orFilter)
  }
  if (q.country) {
    query = query.ilike('country', `%${q.country}%`)
  }

  const { data, error, count } = await query
  if (error) {
    return NextResponse.json(
      { code: 'db_error', error: 'db_error', message: error.message },
      { status: 500 },
    )
  }
  return NextResponse.json({ data: data ?? [], total: count ?? null })
}

export async function POST(request: Request) {
  const auth = await requirePermission(['contact.create'], request)
  if ('error' in auth) return auth.error

  const parsed = await parseJson(request, ContactCreate)
  if ('error' in parsed) return parsed.error
  const body = parsed.data

  const phone = normalizePhone(body.whatsapp_number)
  if (!isLikelyWhatsapp(phone)) {
    return NextResponse.json(
      {
        code: 'invalid_phone',
        error: 'invalid_phone',
        message: 'Phone number does not look like a WhatsApp number',
      },
      { status: 400 },
    )
  }

  const admin = createSupabaseAdminClient()
  const { data, error } = await admin
    .from('contacts')
    .insert({
      whatsapp_number: phone,
      name: body.name,
      email: body.email ?? null,
      country: body.country ?? null,
      country_code: body.country_code?.toUpperCase() ?? null,
      profile_pic_url: body.profile_pic_url ?? null,
      metadata: body.metadata ?? {},
    })
    .select('id, whatsapp_number, name, email, country, country_code, profile_pic_url, created_at, updated_at')
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json(
        { code: 'duplicate', error: 'duplicate', message: 'A contact with that WhatsApp number already exists' },
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
