import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Link2, Send, Unlink } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import clsx from 'clsx'
import { api, ApiError } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { can } from '@/lib/permissions'
import type {
  ConversationDetail,
  ConversationMessage,
} from '@/lib/conversations'

interface LinkedTicket {
  id: string
  name: string
  status: 'open' | 'in_progress' | 'closed'
  assigned_to: string | null
  updated_at: string
}

/**
 * Conversation detail with thread + reply composer + linked-tickets panel.
 */
export default function ConversationDetailPage() {
  const { id = '' } = useParams<{ id: string }>()
  const profile = useAuthStore((s) => s.profile)
  const canReply = can(profile?.role, 'conversation.assign')

  const [detail, setDetail] = useState<ConversationDetail | null>(null)
  const [linked, setLinked] = useState<LinkedTicket[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [linkInput, setLinkInput] = useState('')
  const [linkError, setLinkError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [d, lt] = await Promise.all([
        api.get<{ data: ConversationDetail }>(`/api/conversations/${id}`),
        api.get<{ data: LinkedTicket[] }>(`/api/conversations/${id}/tickets`),
      ])
      setDetail(d.data)
      setLinked(lt.data)
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (id) void load()
  }, [id])

  async function send() {
    if (!draft.trim()) return
    setBusy(true)
    setSendError(null)
    try {
      const res = await api.post<{ data: ConversationMessage }>(
        `/api/conversations/${id}/messages`,
        { body: draft.trim() },
      )
      setDraft('')
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              messages: prev.messages.some((m) => m.id === res.data.id)
                ? prev.messages
                : [...prev.messages, res.data],
            }
          : prev,
      )
    } catch (err) {
      setSendError((err as ApiError).message)
    } finally {
      setBusy(false)
    }
  }

  async function linkTicket() {
    const tid = linkInput.trim()
    if (!tid) return
    setBusy(true)
    setLinkError(null)
    try {
      await api.post(`/api/conversations/${id}/tickets`, { ticket_id: tid })
      setLinkInput('')
      const lt = await api.get<{ data: LinkedTicket[] }>(`/api/conversations/${id}/tickets`)
      setLinked(lt.data)
    } catch (err) {
      setLinkError((err as ApiError).message)
    } finally {
      setBusy(false)
    }
  }

  async function unlink(ticketId: string) {
    if (!confirm('¿Quitar este ticket de la conversación?')) return
    setBusy(true)
    setLinkError(null)
    try {
      await api.del(`/api/conversations/${id}/tickets/${ticketId}`)
      setLinked((prev) => prev.filter((t) => t.id !== ticketId))
    } catch (err) {
      setLinkError((err as ApiError).message)
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return <div className="card p-6 text-sm text-slate-500">Cargando…</div>
  }
  if (error) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
        {error}
      </div>
    )
  }
  if (!detail) return null

  const { conversation, messages } = detail

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Link to="/inbox" className="btn-ghost p-2" aria-label="Volver">
          <ArrowLeft size={16} />
        </Link>
        <h1 className="text-2xl font-semibold text-slate-900">
          {conversation.contact?.name ?? conversation.contact?.whatsapp_number ?? 'Conversación'}
        </h1>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
          {conversation.status}
        </span>
      </div>

      <section className="card p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Tickets vinculados
        </h2>
        {linked.length === 0 ? (
          <p className="text-sm text-slate-500">Sin tickets vinculados.</p>
        ) : (
          <ul className="mb-3 space-y-2">
            {linked.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-2 rounded border border-slate-200 px-3 py-2">
                <Link
                  to={`/tickets/${t.id}`}
                  className="flex flex-1 items-center gap-2 hover:text-indigo-700"
                >
                  <Link2 size={14} className="text-slate-400" />
                  <span className="truncate font-medium text-slate-900">{t.name}</span>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                    {t.status}
                  </span>
                </Link>
                <button
                  type="button"
                  onClick={() => unlink(t.id)}
                  disabled={busy}
                  className="btn-ghost p-1"
                  aria-label="Quitar vínculo"
                  title="Quitar vínculo"
                >
                  <Unlink size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={linkInput}
            onChange={(e) => setLinkInput(e.target.value)}
            placeholder="UUID del ticket"
            className="input flex-1 font-mono text-xs"
          />
          <button
            type="button"
            onClick={linkTicket}
            disabled={busy || !linkInput.trim()}
            className="btn-primary text-sm"
          >
            <Link2 size={14} />
            Vincular
          </button>
        </div>
        {linkError && (
          <p className="mt-2 text-sm text-red-700">{linkError}</p>
        )}
      </section>

      <section className="card p-4">
        <ol className="space-y-3">
          {messages.length === 0 ? (
            <li className="text-sm text-slate-500">Aún no hay mensajes.</li>
          ) : (
            messages.map((m) => <Bubble key={m.id} message={m} />)
          )}
        </ol>
      </section>

      {canReply && (
        <section className="card p-4">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Responder
          </h2>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            placeholder="Escribe tu respuesta…"
            className="input"
          />
          {sendError && (
            <p className="mt-2 text-sm text-red-700">{sendError}</p>
          )}
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={send}
              disabled={busy || !draft.trim()}
              className="btn-primary text-sm"
            >
              <Send size={14} />
              Enviar
            </button>
          </div>
        </section>
      )}
    </div>
  )
}

function Bubble({ message }: { message: ConversationMessage }) {
  const isInbound = message.direction === 'in'
  return (
    <li className={clsx('flex flex-col gap-1', isInbound ? 'items-start' : 'items-end')}>
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span className="font-medium text-slate-700">
          {isInbound ? 'Cliente' : 'Nosotros'}
        </span>
        <span>·</span>
        <span>{formatDistanceToNow(new Date(message.created_at), { addSuffix: true })}</span>
        {message.twilio_status && (
          <>
            <span>·</span>
            <span className="italic">{message.twilio_status}</span>
          </>
        )}
      </div>
      <div
        className={clsx(
          'max-w-[80%] rounded-md border px-3 py-2 text-sm whitespace-pre-wrap',
          isInbound
            ? 'border-slate-200 bg-slate-50 text-slate-800'
            : 'border-brand-200 bg-brand-50 text-slate-900',
        )}
      >
        {message.body || '(sin contenido)'}
      </div>
    </li>
  )
}