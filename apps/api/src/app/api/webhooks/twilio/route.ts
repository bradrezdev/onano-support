/**
 * Webhook de mensajes entrantes de WhatsApp (Twilio).
 *
 * Twilio manda POST `application/x-www-form-urlencoded` con `From`, `To`,
 * `Body`, `MessageSid`, `NumMedia`, `MediaUrl0..N` y `ProfileName`, y firma
 * la petición en `X-Twilio-Signature`.
 *
 * Reglas (E3):
 *   1 · Sin `TWILIO_AUTH_TOKEN` → 503 y NADA escrito. La validación NUNCA se
 *       omite: una entrada externa sin credencial no se acepta.
 *   2 · Sin `WEBHOOK_BASE_URL` → 503 y NADA escrito: sin la URL pública no se
 *       puede saber qué firmó Twilio.
 *   3 · La firma se valida con el SDK de Twilio contra la URL PÚBLICA
 *       (`WEBHOOK_BASE_URL` + ruta + query string), no contra `request.url`:
 *       detrás de un proxy son distintas y toda petición legítima caería en
 *       403.
 *   4 · Firma inválida → 403 y NADA escrito.
 *   5 · La recepción se guarda en UNA transacción (cliente + hilo + mensaje).
 *       Un fallo de almacenamiento responde 5xx — NUNCA 200: un 200 con
 *       "mensaje perdido" no se puede reintentar.
 *   6 · El acuse es TwiML vacío, y solo se emite cuando la recepción quedó
 *       guardada o se comprobó que ya lo estaba.
 *
 * Política de reintentos del piloto: por defecto Twilio reintenta UNA vez y
 * solo ante fallo de conexión (`rc=1`, `rp=ct`), así que un 5xx NO se
 * reintenta salvo que la URL del webhook en la consola de Twilio lleve los
 * overrides de conexión (`#rc=3&rp=5xx,ct,rt`) o se configuren por la
 * Webhooks configuration API. Esos overrides viajan en el FRAGMENTO de la
 * URL, que no entra en el cálculo de la firma: por eso la URL pública se
 * construye sin fragmento.
 */

import { NextResponse } from 'next/server'
import twilio from 'twilio'
import { z } from 'zod'
import { acceptInboundWhatsApp, WhatsappInboundError } from '@/services/whatsapp-inbound'

/** Acuse a Twilio: TwiML vacío. */
export const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'

const inboundSchema = z.object({
  From: z.string().trim().min(1),
  MessageSid: z.string().trim().min(1),
  Body: z.string().nullish(),
  ProfileName: z.string().nullish(),
})

/** Máximo de medios que se aceptan de una sola vez (guardia contra abuso). */
const MAX_MEDIA = 20

/**
 * La URL PÚBLICA que firmó Twilio: el origen público + la ruta + el query
 * string. Sin el fragmento: los overrides de conexión viajan ahí y no son
 * parte de la firma.
 */
export function buildPublicWebhookUrl(request: Request, baseUrl: string): string {
  const base = new URL(baseUrl)
  const incoming = new URL(request.url)
  return `${base.protocol}//${base.host}${incoming.pathname}${incoming.search}`
}

function extractMediaUrls(params: Record<string, string>): string[] {
  const numMedia = Number(params.NumMedia ?? '0')
  const count = Number.isFinite(numMedia) ? Math.min(Math.max(Math.trunc(numMedia), 0), MAX_MEDIA) : 0
  const urls: string[] = []
  for (let i = 0; i < count; i++) {
    const url = params[`MediaUrl${i}`]
    if (url) urls.push(url)
  }
  return urls
}

export async function POST(request: Request) {
  const authToken = process.env.TWILIO_AUTH_TOKEN
  if (!authToken) {
    // Configuración ausente: no se acepta la entrada ni se escribe nada.
    // eslint-disable-next-line no-console
    console.error(
      '[twilio webhook] TWILIO_AUTH_TOKEN no está configurado: la recepción se rechaza sin escribir nada',
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
      '[twilio webhook] WEBHOOK_BASE_URL no está configurado: no se puede reconstruir la URL pública que firmó Twilio',
    )
    return NextResponse.json(
      {
        code: 'webhook_base_url_missing',
        message: 'Falta la URL pública del webhook',
      },
      { status: 503 },
    )
  }

  // Twilio manda application/x-www-form-urlencoded.
  const form = await request.formData()
  const params: Record<string, string> = {}
  for (const [key, value] of form.entries()) {
    params[key] = typeof value === 'string' ? value : value.name
  }

  const signature = request.headers.get('x-twilio-signature')
  let publicUrl: string
  try {
    publicUrl = buildPublicWebhookUrl(request, baseUrl)
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

  const parsed = inboundSchema.safeParse(params)
  if (!parsed.success) {
    return NextResponse.json(
      {
        code: 'invalid_payload',
        message: 'La carga de Twilio no trae From o MessageSid',
      },
      { status: 400 },
    )
  }

  try {
    await acceptInboundWhatsApp({
      from: parsed.data.From,
      body: parsed.data.Body ?? null,
      twilio_sid: parsed.data.MessageSid,
      profile_name: parsed.data.ProfileName ?? null,
      media_urls: extractMediaUrls(params),
    })
    // El acuse se emite solo cuando la recepción quedó guardada (o ya lo
    // estaba): Twilio no debe reintentar un evento ya procesado.
    return new NextResponse(EMPTY_TWIML, {
      status: 200,
      headers: { 'Content-Type': 'text/xml' },
    })
  } catch (err) {
    const status = err instanceof WhatsappInboundError ? err.status : 500
    const code = err instanceof WhatsappInboundError ? err.code : 'storage_unavailable'
    // eslint-disable-next-line no-console
    console.error(
      '[twilio webhook] no se pudo guardar la recepción entrante:',
      (err as Error).message,
    )
    // 5xx: un fallo temporal de almacenamiento se puede reintentar. Un 200
    // aquí sería un mensaje perdido sin que nadie lo note.
    return NextResponse.json(
      { code, message: 'No se pudo guardar la recepción entrante' },
      { status },
    )
  }
}
