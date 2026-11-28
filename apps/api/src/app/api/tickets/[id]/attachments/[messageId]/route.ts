import { NextResponse } from 'next/server'
import { requirePermission } from '@/lib/auth'
import {
  detachMessage,
  downloadAttachment,
  AttachmentError,
} from '@/services/message-attachments'

type Params = { params: Promise<{ id: string; messageId: string }> }

/**
 * `Content-Disposition` con un nombre que no rompa la cabecera: se quitan las
 * comillas y los saltos de línea del nombre, y se añade la forma
 * `filename*` (RFC 6266) para los nombres con acentos.
 */
function contentDisposition(kind: 'inline' | 'attachment', filename: string): string {
  const safe = filename.replace(/[\r\n"\\]/g, '_')
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_')
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`
}

/**
 * GET /api/tickets/:id/attachments/:messageId — el ARCHIVO del adjunto.
 *
 * La API sirve los BYTES, no una URL firmada: la autorización se vuelve a
 * comprobar en CADA petición, así que perder el permiso cierra la puerta en
 * el momento en que se pierde y no cinco minutos después. La URL firmada
 * sobrevivía a la pérdida de permiso, y con ella el archivo.
 *
 * `?download=1` cambia la disposición de `inline` a `attachment` (la vista
 * previa y la descarga son el mismo recurso con distinto encabezado).
 */
export async function GET(request: Request, ctx: Params) {
  const auth = await requirePermission(['ticket.read'], request)
  if ('error' in auth) return auth.error
  const { id, messageId } = await ctx.params

  try {
    const file = await downloadAttachment(id, messageId, auth.user)
    const asDownload = new URL(request.url).searchParams.get('download') === '1'
    return new Response(file.data, {
      status: 200,
      headers: {
        'Content-Type': file.content_type,
        'Content-Disposition': contentDisposition(
          asDownload ? 'attachment' : 'inline',
          file.filename,
        ),
        // El contenido es del usuario: nunca se guarda en una caché común.
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
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

/**
 * DELETE /api/tickets/:id/attachments/:messageId — unpin a message.
 *
 * The row in `ticket_message_attachments` disappears; the message in
 * `messages` does not. Unpinning is a judgement ("this was the wrong
 * evidence"), never a way to delete a message.
 *
 * The FILE DOES NOT GO AWAY: the same object can be linked to another ticket
 * (or live in another message), and deleting it here would leave that other
 * reference broken. The physical deletion is a separate authorized operation:
 * `POST /api/tickets/:id/attachments/:messageId/purge`.
 */
export async function DELETE(request: Request, ctx: Params) {
  const auth = await requirePermission(['ticket.reply'], request)
  if ('error' in auth) return auth.error
  const { id, messageId } = await ctx.params

  try {
    await detachMessage(id, messageId, auth.user)
    return new NextResponse(null, { status: 204 })
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
