/**
 * Inbound WhatsApp message webhook.
 *
 * Twilio sends POST with `From`, `To`, `Body`, `MessageSid`, `NumMedia`,
 * `MediaUrl0..N`. Signature in `X-Twilio-Signature` header.
 *
 * Flow:
 *   1. Verify X-Twilio-Signature (HMAC-SHA1 of URL + sorted POST params).
 *   2. Look up contact by From (whatsapp_number) — skip silently if unknown.
 *   3. find-or-create conversation for that contact.
 *   4. Insert message idempotently (onConflict twilio_sid ignoreDuplicates).
 *
 * Always returns 200 OK to Twilio even on skip — Twilio retries non-2xx.
 */

import { NextResponse } from 'next/server'
import {
  verifyTwilioSignature,
} from '@/lib/twilio-signature'
import {
  findContactByWhatsappNumber,
  findOrCreateConversationForContact,
  appendInboundMessage,
} from '@/services/conversations'

export async function POST(request: Request) {
  const url = new URL(request.url)
  const authToken = process.env.TWILIO_AUTH_TOKEN
  const signature = request.headers.get('x-twilio-signature')

  // Twilio sends application/x-www-form-urlencoded.
  const form = await request.formData()
  const params: Record<string, string> = {}
  for (const [k, v] of form.entries()) {
    params[k] = typeof v === 'string' ? v : v.name
  }

  if (!verifyTwilioSignature(signature, url.toString(), params, authToken)) {
    return NextResponse.json(
      { code: 'invalid_signature', message: 'Invalid Twilio signature' },
      { status: 403 },
    )
  }

  const from = params.From ?? ''
  const body = params.Body ?? null
  const sid = params.MessageSid ?? ''
  if (!from || !sid) {
    return NextResponse.json({ ok: true, skipped: 'missing From or MessageSid' })
  }

  try {
    const contact = await findContactByWhatsappNumber(from)
    if (!contact) {
      return NextResponse.json({ ok: true, skipped: 'unknown_contact', from })
    }
    const conversation = await findOrCreateConversationForContact(contact.id)
    await appendInboundMessage({
      conversation_id: conversation.id,
      body,
      twilio_sid: sid,
      media_urls: extractMediaUrls(params),
    })
    return NextResponse.json({ ok: true, conversation_id: conversation.id })
  } catch (err) {
    // Log but always return 200 — Twilio would otherwise retry forever.
    // eslint-disable-next-line no-console
    console.error('[twilio webhook] failed to process inbound', (err as Error).message)
    return NextResponse.json({ ok: true, error: (err as Error).message })
  }
}

function extractMediaUrls(params: Record<string, string>): string[] {
  const urls: string[] = []
  const numMedia = Number(params.NumMedia ?? '0')
  for (let i = 0; i < numMedia; i++) {
    const u = params[`MediaUrl${i}`]
    if (u) urls.push(u)
  }
  return urls
}