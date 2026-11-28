/**
 * Aceptación de un mensaje entrante de WhatsApp.
 *
 * Todo el camino entrante se resuelve en UNA operación de base de datos
 * (`accept_inbound_whatsapp`, SECURITY DEFINER): crear el cliente si no
 * existe, reutilizar o reabrir el hilo del canal, e insertar el mensaje
 * ignorando un `MessageSid` repetido. Eso es lo que hace que dos entregas
 * simultáneas del mismo mensaje dejen UN mensaje, UN hilo y UN incremento de
 * no leídos.
 *
 * El servicio no decide nada: traduce la llamada y los errores de la base a
 * errores con `status` + `code`, que la ruta traduce a su vez en una
 * respuesta HTTP honesta.
 */

import { createSupabaseAdminClient } from '@/lib/supabase/admin'
import { normalizePhone } from '@/lib/phone'

/** El canal de la conversación: hoy solo WhatsApp, pero la columna existe. */
export const WHATSAPP_CHANNEL = 'whatsapp' as const

export interface InboundWhatsAppInput {
  /** `whatsapp:+52...` tal como lo manda Twilio. */
  from: string
  body: string | null
  twilio_sid: string
  /** Nombre de perfil de WhatsApp: se usa al crear el cliente. */
  profile_name?: string | null
  media_urls?: string[]
}

export interface InboundWhatsAppResult {
  conversation_id: string
  message_id: string
  contact_id: string
  /** `false` cuando el `MessageSid` ya estaba guardado: no se insertó nada. */
  inserted: boolean
  status: 'open' | 'pending' | 'closed'
  unread_count: number
}

/**
 * Error con la forma del repo: `status` + `code`. La ruta decide el código
 * HTTP a partir de aquí.
 */
export class WhatsappInboundError extends Error {
  status: number
  code: string
  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'WhatsappInboundError'
    this.code = code
    this.status = status
  }
}

interface AcceptedRow {
  conversation_id: string
  message_id: string
  contact_id: string
  inserted: boolean
  status: 'open' | 'pending' | 'closed'
  unread_count: number
}

/**
 * Los SQLSTATE propios de la función de aceptación. No son fallos de la
 * base: son de la PETICIÓN, y reintentar no los arregla.
 */
const RPC_VALIDATION_ERRORS: Record<string, { code: string; message: string; status: number }> = {
  C0011: {
    code: 'invalid_payload',
    message: 'El teléfono de la recepción no es válido',
    status: 400,
  },
  C0012: {
    code: 'invalid_payload',
    message: 'La recepción no trae MessageSid',
    status: 400,
  },
}

/**
 * `whatsapp:+52 55 1234 5678` → `+525512345678`. La misma normalización se
 * hace en SQL, para que el número que se busca sea siempre el mismo.
 */
function normalizeFrom(raw: string): string {
  const withoutPrefix = raw.trim().replace(/^whatsapp:/i, '')
  return normalizePhone(withoutPrefix)
}

/**
 * Entrega el mensaje entrante a la base.
 *
 * Un error de la base es TEMPORAL: la ruta responde 5xx para que Twilio
 * pueda reintentar (con los overrides de conexión configurados en la URL del
 * webhook). Un `MessageSid` repetido NO es un error: la función devuelve
 * `inserted = false` y la ruta acusa igual con TwiML vacío.
 */
export async function acceptInboundWhatsApp(
  input: InboundWhatsAppInput,
): Promise<InboundWhatsAppResult> {
  const phone = normalizeFrom(input.from)
  const twilioSid = input.twilio_sid.trim()
  if (!phone || phone === '+' || !twilioSid) {
    throw new WhatsappInboundError(
      'invalid_payload',
      'La recepción no trae teléfono o MessageSid',
      400,
    )
  }

  const profileName = input.profile_name?.trim() ?? ''

  const admin = createSupabaseAdminClient()
  const { data, error } = await admin.rpc('accept_inbound_whatsapp', {
    p_phone: phone,
    p_profile_name: profileName === '' ? null : profileName,
    p_twilio_sid: twilioSid,
    p_body: input.body ?? null,
    p_media_urls: input.media_urls ?? [],
  })

  if (error) {
    // El SQLSTATE es el contrato; el texto raised es el mismo código, así que
    // el mapeo sobrevive aunque el SQLSTATE no llegue al cliente.
    const byState = error.code ? RPC_VALIDATION_ERRORS[error.code] : undefined
    const text = (error.message ?? '').trim()
    const byText = Object.values(RPC_VALIDATION_ERRORS).find((e) => e.message === text)
    const known = byState ?? byText
    if (known) {
      throw new WhatsappInboundError(known.code, known.message, known.status)
    }
    throw new WhatsappInboundError(
      'storage_unavailable',
      `No se pudo guardar la recepción: ${error.message}`,
      503,
    )
  }

  const row = (Array.isArray(data) ? data[0] : data) as AcceptedRow | null
  if (!row) {
    throw new WhatsappInboundError(
      'storage_unavailable',
      'La base no devolvió la recepción aceptada',
      503,
    )
  }

  return {
    conversation_id: row.conversation_id,
    message_id: row.message_id,
    contact_id: row.contact_id,
    inserted: Boolean(row.inserted),
    status: row.status,
    unread_count: Number(row.unread_count ?? 0),
  }
}
