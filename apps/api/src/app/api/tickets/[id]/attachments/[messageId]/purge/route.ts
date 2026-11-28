import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { parseJson } from '@/lib/validate'
import { purgeAttachment, AttachmentError } from '@/services/message-attachments'

type Params = { params: Promise<{ id: string; messageId: string }> }

const PurgeBody = z.object({
  reason: z.string().min(1).max(500),
})

/**
 * POST /api/tickets/:id/attachments/:messageId/purge — el BORRADO FÍSICO del
 * archivo.
 *
 * Es una operación aparte, y más delicada que desvincular: exige `admin` o
 * `supervisor`, comprueba que no queda ninguna referencia al objeto (ningún
 * vínculo de ticket a un mensaje que lleve esa ruta) y que se respetó la
 * ventana de conservación (`RETENTION_DAYS`, 30 días por defecto). Sólo
 * entonces borra el objeto del bucket y deja la bitácora en
 * `attachment_purge_log` (append-only: quién, qué ticket, qué mensaje, qué
 * ruta, cuándo y por qué).
 *
 * Los rechazos explican por qué: 409 `attachment_referenced` (alguien más
 * todavía lo usa) o 409 `attachment_retention_window` (la ventana no ha
 * pasado).
 */
export async function POST(request: Request, ctx: Params) {
  const auth = await requirePermission(['ticket.reply'], request)
  if ('error' in auth) return auth.error
  const { id, messageId } = await ctx.params

  const parsed = await parseJson(request, PurgeBody)
  if ('error' in parsed) return parsed.error

  try {
    const result = await purgeAttachment(
      id,
      messageId,
      auth.user,
      parsed.data.reason,
    )
    return NextResponse.json({ data: result })
  } catch (err) {
    if (err instanceof AttachmentError) {
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
