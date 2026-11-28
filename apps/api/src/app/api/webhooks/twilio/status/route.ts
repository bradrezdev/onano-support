/**
 * Twilio message status callback.
 * Updates twilio_status on the matching messages row (by twilio_sid).
 *
 * Twilio sends: MessageSid, MessageStatus (queued|sent|delivered|read|failed).
 *
 * La firma se valida con el SDK de Twilio contra la URL PÚBLICA
 * (`WEBHOOK_BASE_URL` + ruta + query string), igual que el webhook entrante:
 * detrás de un proxy, `request.url` no es la URL que firmó Twilio.
 *
 * Sin `TWILIO_AUTH_TOKEN` o sin `WEBHOOK_BASE_URL` la petición se rechaza con
 * 503 y no se escribe nada: la validación nunca se omite. Una firma inválida
 * se rechaza con 403. Un fallo de almacenamiento responde 5xx, nunca 200.
 */

import { NextResponse } from 'next/server'
import twilio from 'twilio'
import { updateMessageStatusBySid } from '@/services/conversations'

const ALLOWED_STATUSES = ['queued', 'sent', 'delivered', 'read', 'failed'] as const
type AllowedStatus = (typeof ALLOWED_STATUSES)[number]

function isAllowedStatus(s: string): s is AllowedStatus {
  return (ALLOWED_STATUSES as readonly string[]).includes(s)
}

/** La URL PÚBLICA que firmó Twilio (sin fragmento: no entra en la firma). */
export function buildPublicStatusUrl(request: Request, baseUrl: string): string {
  const base = new URL(baseUrl)
  const incoming = new URL(request.url)
  return `${base.protocol}//${base.host}${incoming.pathname}${incoming.search}`
}

export async function POST(request: Request) {
  const authToken = process.env.TWILIO_AUTH_TOKEN
  if (!authToken) {
    // eslint-disable-next-line no-console
    console.error(
      '[twilio status] TWILIO_AUTH_TOKEN no está configurado: la llamada se rechaza sin escribir nada',
    )
    return NextResponse.json(
      {
        code: 'twilio_not_configured',
        message: 'El webhook no tiene credencial de Twilio configurada',
      },
      { status: 503 },
    )
  }

  const baseUrl = process.env.WEBHOOK_BASE_URL
  if (!baseUrl) {
    // eslint-disable-next-line no-console
    console.error(
      '[twilio status] WEBHOOK_BASE_URL no está configurado: no se puede reconstruir la URL pública que firmó Twilio',
    )
    return NextResponse.json(
      {
        code: 'webhook_base_url_missing',
        message: 'Falta la URL pública del webhook',
      },
      { status: 503 },
    )
  }

  const form = await request.formData()
  const params: Record<string, string> = {}
  for (const [key, value] of form.entries()) {
    params[key] = typeof value === 'string' ? value : value.name
  }

  const signature = request.headers.get('x-twilio-signature')
  let publicUrl: string
  try {
    publicUrl = buildPublicStatusUrl(request, baseUrl)
  } catch {
    return NextResponse.json(
      {
        code: 'webhook_base_url_invalid',
        message: 'WEBHOOK_BASE_URL no es una URL válida',
      },
      { status: 503 },
    )
  }

  if (!signature || !twilio.validateRequest(authToken, signature, publicUrl, params)) {
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
    console.error('[twilio status] no se pudo guardar el estado:', (err as Error).message)
    // 5xx: un estado perdido no se puede recuperar si se acusa con 200.
    return NextResponse.json(
      { code: 'storage_unavailable', message: 'No se pudo guardar el estado del mensaje' },
      { status: 503 },
    )
  }
}
