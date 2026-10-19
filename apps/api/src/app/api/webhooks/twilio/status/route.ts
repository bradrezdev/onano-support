/**
 * Twilio message status callback.
 * Updates twilio_status on the matching messages row (by twilio_sid).
 *
 * Twilio sends: MessageSid, MessageStatus (queued|sent|delivered|read|failed).
 * Signature validated the same way as the inbound webhook.
 */

import { NextResponse } from 'next/server'
import { verifyTwilioSignature } from '@/lib/twilio-signature'
import { updateMessageStatusBySid } from '@/services/conversations'

const ALLOWED_STATUSES = ['queued', 'sent', 'delivered', 'read', 'failed'] as const
type AllowedStatus = (typeof ALLOWED_STATUSES)[number]

function isAllowedStatus(s: string): s is AllowedStatus {
  return (ALLOWED_STATUSES as readonly string[]).includes(s)
}

export async function POST(request: Request) {
  const url = new URL(request.url)
  const authToken = process.env.TWILIO_AUTH_TOKEN
  const signature = request.headers.get('x-twilio-signature')

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

  const sid = params.MessageSid ?? ''
  const status = params.MessageStatus ?? ''
  if (!sid || !isAllowedStatus(status)) {
    return NextResponse.json({ ok: true, skipped: 'missing sid or invalid status' })
  }

  try {
    const { updated } = await updateMessageStatusBySid(sid, status)
    return NextResponse.json({ ok: true, updated })
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[twilio status] failed', (err as Error).message)
    return NextResponse.json({ ok: true, error: (err as Error).message })
  }
}