import { useEffect, useState } from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import { ArrowLeft, Check, Inbox, RotateCcw, Send } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { api, ApiError } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { RichTextEditor, RichTextRenderer } from '@/components/ui/RichTextEditor'
import { bubbleStyle } from '@/lib/roleColors'
import { previewSnippet, type LinkedConversationSummary } from '@/lib/conversations'
import { can, type Role } from '@/lib/permissions'

interface Ticket {
  id: string
  name: string
  status: 'open' | 'in_progress' | 'closed'
  description: unknown
  description_plain: string
  contact_id: string
  category_id: string
  assigned_to: string | null
  theme_id: string | null
  flow_id: string | null
  created_by: string
  closed_by: string | null
  closed_at: string | null
  reopened_by: string | null
  reopened_at: string | null
  created_at: string
  updated_at: string
}

interface TicketMessage {
  id: string
  ticket_id: string
  author_id: string
  body: unknown
  body_plain: string
  role_at_send: Role
  fade_step: number
  created_at: string
}

const STATUS_BADGE: Record<Ticket['status'], string> = {
  open: 'bg-emerald-100 text-emerald-700',
  in_progress: 'bg-amber-100 text-amber-700',
  closed: 'bg-slate-200 text-slate-700',
}

const ROLE_LABEL: Record<Role, string> = {
  admin: 'Admin',
  supervisor: 'Supervisor',
  soporte: 'Soporte',
}

export default function TicketDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const profile = useAuthStore((s) => s.profile)
  const isAdmin = profile?.role === 'admin'
  const canReply = can(profile?.role, 'ticket.reply')

  const [ticket, setTicket] = useState<Ticket | null>(null)
  const [messages, setMessages] = useState<TicketMessage[]>([])
  const [linkedConvs, setLinkedConvs] = useState<LinkedConversationSummary[]>([])
  const [draft, setDraft] = useState<unknown>({ type: 'doc', content: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)

  async function loadTicket() {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<{ data: Ticket }>(`/api/tickets/${id}`)
      setTicket(res.data)
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setLoading(false)
    }
  }

  async function loadMessages() {
    if (!id) return
    try {
      const res = await api.get<{ data: TicketMessage[] }>(`/api/tickets/${id}/messages`)
      setMessages(res.data)
    } catch (err) {
      // Non-fatal: thread silently empty if backend errors.
      // eslint-disable-next-line no-console
      console.warn('[ticket] loadMessages failed', err)
    }
  }

  async function loadLinkedConversations() {
    if (!id) return
    try {
      const res = await api.get<{ data: LinkedConversationSummary[] }>(`/api/tickets/${id}/conversations`)
      setLinkedConvs(res.data)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[ticket] loadLinkedConversations failed', err)
    }
  }

  useEffect(() => {
    if (id) void loadTicket()
  }, [id])

  useEffect(() => {
    if (id && ticket) {
      void loadMessages()
      void loadLinkedConversations()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, ticket?.id])

  async function close() {
    if (!ticket) return
    setBusy(true)
    try {
      await api.post(`/api/tickets/${ticket.id}/close`)
      await loadTicket()
    } catch (err) {
      alert((err as ApiError).message)
    } finally {
      setBusy(false)
    }
  }

  async function reopen() {
    if (!ticket) return
    setBusy(true)
    try {
      await api.post(`/api/tickets/${ticket.id}/reopen`)
      await loadTicket()
    } catch (err) {
      alert((err as ApiError).message)
    } finally {
      setBusy(false)
    }
  }

  async function sendMessage() {
    if (!ticket || !id) return
    setBusy(true)
    setSendError(null)
    try {
      await api.post(`/api/tickets/${id}/messages`, { body: draft })
      setDraft({ type: 'doc', content: [] })
      await loadMessages()
    } catch (err) {
      setSendError((err as ApiError).message)
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return <div className="card p-6 text-sm text-slate-500">Cargando…</div>
  }
  if (error) {
    return <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
  }
  if (!ticket) return null

  const isClosed = ticket.status === 'closed'

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <button
        type="button"
        onClick={() => navigate(-1)}
        className="btn-ghost text-sm"
      >
        <ArrowLeft size={14} />
        Volver
      </button>

      <header className="card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <h1 className="text-2xl font-semibold text-slate-900">{ticket.name}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[ticket.status]}`}>
                {ticket.status}
              </span>
              <span>·</span>
              <span>Creado {formatDistanceToNow(new Date(ticket.created_at), { addSuffix: true })}</span>
              {ticket.closed_at && (
                <>
                  <span>·</span>
                  <span>Cerrado {formatDistanceToNow(new Date(ticket.closed_at), { addSuffix: true })}</span>
                </>
              )}
            </div>
          </div>
          {isAdmin && (
            <div className="flex gap-2">
              {!isClosed ? (
                <button
                  type="button"
                  onClick={close}
                  disabled={busy}
                  className="btn-ghost text-sm"
                >
                  <Check size={14} />
                  Cerrar
                </button>
              ) : (
                <button
                  type="button"
                  onClick={reopen}
                  disabled={busy}
                  className="btn-ghost text-sm"
                >
                  <RotateCcw size={14} />
                  Reabrir
                </button>
              )}
            </div>
          )}
        </div>
      </header>

      <section className="card p-5">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Descripción
        </h2>
        <div className="prose prose-sm max-w-none text-slate-800">
          <RichTextRenderer value={ticket.description} />
        </div>
      </section>

      <section className="card p-5">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          <Inbox size={14} />
          Conversaciones vinculadas
        </h2>
        {linkedConvs.length === 0 ? (
          <p className="text-sm text-slate-500">Sin conversaciones vinculadas.</p>
        ) : (
          <ul className="space-y-2">
            {linkedConvs.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-2 rounded border border-slate-200 px-3 py-2">
                <Link
                  to={`/inbox/${c.id}`}
                  className="flex flex-1 items-center gap-2 hover:text-indigo-700"
                >
                  <Inbox size={14} className="text-slate-400" />
                  <span className="truncate text-sm font-medium text-slate-900">
                    {previewSnippet(c.last_message_preview, 60) || `Conversación ${c.id.slice(0, 8)}…`}
                  </span>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                    {c.status}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card p-5">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Detalles
        </h2>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <Detail label="Contacto" value={ticket.contact_id.slice(0, 8) + '…'} />
          <Detail label="Categoría" value={ticket.category_id.slice(0, 8) + '…'} />
          <Detail label="Asignado a" value={ticket.assigned_to?.slice(0, 8) ?? '—'} />
          <Detail label="Tema" value={ticket.theme_id?.slice(0, 8) ?? '—'} />
          <Detail label="Flujo" value={ticket.flow_id?.slice(0, 8) ?? '—'} />
          <Detail label="Creado por" value={ticket.created_by.slice(0, 8) + '…'} />
        </dl>
      </section>

      <section className="card p-5">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Conversación
        </h2>
        {messages.length === 0 ? (
          <p className="text-sm text-slate-500">Aún no hay mensajes.</p>
        ) : (
          <ol className="space-y-3">
            {messages.map((m) => (
              <li key={m.id} className="flex flex-col gap-1">
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <span className="font-medium text-slate-700">{ROLE_LABEL[m.role_at_send]}</span>
                  <span>·</span>
                  <span>{formatDistanceToNow(new Date(m.created_at), { addSuffix: true })}</span>
                </div>
                <div
                  className="rounded-md border px-3 py-2 text-sm text-slate-800 prose prose-sm max-w-none"
                  style={bubbleStyle(m.role_at_send, m.fade_step)}
                >
                  <RichTextRenderer value={m.body} />
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      {canReply && (
        <section className="card p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Responder
          </h2>
          {isClosed ? (
            <p className="text-sm text-slate-500">
              El ticket está cerrado. Reábrelo para responder.
            </p>
          ) : (
            <div className="space-y-2">
              <RichTextEditor
                value={draft}
                onChange={setDraft}
                placeholder="Escribe tu respuesta…"
              />
              {sendError && (
                <p className="text-sm text-red-700">{sendError}</p>
              )}
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={sendMessage}
                  disabled={busy}
                  className="btn-primary text-sm"
                >
                  <Send size={14} />
                  Enviar
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="font-mono text-xs text-slate-700">{value}</dd>
    </>
  )
}