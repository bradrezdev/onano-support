import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Link2, Send, Unlink, Hand, UserPlus, Paperclip } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import clsx from 'clsx'
import { api, ApiError } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { canWith } from '@/lib/permissions'
import { clearDraft, draftKey, readDraft, writeDraft } from '@/lib/drafts'
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

interface AssignableAgent {
  id: string
  display_name: string | null
  role: 'admin' | 'supervisor' | 'soporte'
}

/**
 * Conversation detail with thread + reply composer + linked-tickets panel.
 *
 * Ownership controls: "Tomar" (unassigned queue), "Pedir apoyo" (W3) and
 * "Reasignar" (W4, admin/supervisor only).
 */
export default function ConversationDetailPage() {
  const { id = '' } = useParams<{ id: string }>()
  const profile = useAuthStore((s) => s.profile)
  const canReply = canWith(profile, 'conversation.assign')
  const canReassign = canWith(profile, 'conversation.reassign')

  const [detail, setDetail] = useState<ConversationDetail | null>(null)
  const [linked, setLinked] = useState<LinkedTicket[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  /**
   * The draft belongs to ONE (agent, chat) pair. The agent id comes from the
   * resolved profile (the API decides who the agent is, never the browser),
   * and the chat id from the route. The key carries both, so the browser
   * never mixes two people's answers.
   */
  const agentId = profile?.id ?? null
  const draftScope = agentId && id ? draftKey(agentId, id) : null
  const [draftScopeLoaded, setDraftScopeLoaded] = useState<string | null>(null)
  /** The actor lost every right over this chat: the case is withdrawn. */
  const [accessLost, setAccessLost] = useState(false)
  const [busy, setBusy] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [linkInput, setLinkInput] = useState('')
  const [linkError, setLinkError] = useState<string | null>(null)
  const [agents, setAgents] = useState<AssignableAgent[]>([])
  const [ownerChoice, setOwnerChoice] = useState('')
  const [reason, setReason] = useState('')

  // W1: pick messages here, pin them to a ticket there.
  const [attachMode, setAttachMode] = useState(false)
  const [selectedMessages, setSelectedMessages] = useState<Set<string>>(new Set())
  const [attachTicket, setAttachTicket] = useState('')
  const [attachError, setAttachError] = useState<string | null>(null)

  function toggleMessage(messageId: string) {
    setSelectedMessages((prev) => {
      const next = new Set(prev)
      if (next.has(messageId)) next.delete(messageId)
      else next.add(messageId)
      return next
    })
  }

  /**
   * Changing chat (or agent) leaves the previous draft behind: the draft of
   * one client never appears in another client's conversation.
   *
   * This is React's "adjust the state when the inputs change" pattern: the
   * draft is re-read during the render that follows the change, not in an
   * effect, so the screen never shows one frame with the wrong draft.
   */
  if (draftScope !== draftScopeLoaded) {
    setDraftScopeLoaded(draftScope)
    setDraft(draftScope && agentId ? readDraft(agentId, id) : '')
  }

  /** Writes the draft as the operator types, under the (agent, chat) key. */
  function updateDraft(value: string) {
    setDraft(value)
    if (agentId) writeDraft(agentId, id, value)
  }

  /**
   * The actor lost every right over this chat (the API answered 403): the
   * cached history leaves the screen and the draft of a chat that can no
   * longer be opened goes with it.
   */
  function withdrawAccess() {
    setAccessLost(true)
    setDetail(null)
    setLinked([])
    setDraft('')
    if (agentId) clearDraft(agentId, id)
  }

  async function attachSelected() {
    if (!attachTicket || selectedMessages.size === 0) return
    setBusy(true)
    setAttachError(null)
    try {
      await api.post(`/api/tickets/${attachTicket}/attachments`, {
        message_ids: [...selectedMessages],
      })
      setSelectedMessages(new Set())
      setAttachMode(false)
    } catch (err) {
      setAttachError((err as ApiError).message)
    } finally {
      setBusy(false)
    }
  }

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
      // The chat is readable: the withdrawal notice of a previous chat (or a
      // previous attempt) does not follow the operator to this one.
      setAccessLost(false)
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        // The chat is not readable any more: the history leaves the screen.
        withdrawAccess()
        return
      }
      setError((err as ApiError).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (id) void load()
  }, [id])

  // Only fetch the agent list when a control that needs it is visible.
  useEffect(() => {
    if (!canReassign) return
    void (async () => {
      try {
        const res = await api.get<{ data: AssignableAgent[] }>('/api/users/assignable')
        setAgents(res.data)
      } catch {
        // Non-fatal: the pickers just stay empty.
      }
    })()
  }, [canReassign])

  async function take() {
    setBusy(true)
    setError(null)
    try {
      await api.post(`/api/conversations/${id}/take`)
      await load()
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setBusy(false)
    }
  }

  async function reassign(agentId: string | null) {
    if (!reason.trim()) {
      setError('Indica el motivo de la transferencia')
      return
    }
    if (!detail) return

    setBusy(true)
    setError(null)
    try {
      await api.patch(`/api/conversations/${id}`, {
        assigned_agent_id: agentId,
        reason: reason.trim(),
        expected_version: detail.conversation.assignment_version,
      })
      setOwnerChoice('')
      setReason('')
      await load()
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.status === 409 &&
        err.code === 'version_conflict'
      ) {
        await load()
        setError('El chat cambió mientras lo transferías: revisa el titular actual.')
      } else {
        setError((err as ApiError).message)
      }
    } finally {
      setBusy(false)
    }
  }

  async function askForHelp(agentId: string) {
    setBusy(true)
    setError(null)
    try {
      await api.post(`/api/conversations/${id}/escalate`, { to_user_id: agentId })
      await load()
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setBusy(false)
    }
  }

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
      if (agentId) clearDraft(agentId, id)
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
      if (err instanceof ApiError && err.status === 403) {
        // The chat was taken away while the answer was being written: the
        // history and the draft leave the screen.
        withdrawAccess()
        return
      }
      if (
        err instanceof ApiError &&
        err.status === 409 &&
        err.code === 'assignment_changed'
      ) {
        setSendError(
          'Este chat cambió de titular mientras redactabas: tu mensaje no se guardó.',
        )
        await load()
      } else {
        setSendError((err as ApiError).message)
      }
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
  if (accessLost) {
    return (
      <div
        className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
        aria-live="polite"
      >
        Ya no tienes acceso a esta conversación: se retiró el historial de esta
        pantalla.
      </div>
    )
  }
  if (error) {
    return (
      <div
        className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        aria-live="polite"
      >
        {error}
      </div>
    )
  }
  if (!detail) return null

  const { conversation, messages } = detail
  const isUnassigned = conversation.assigned_agent_id === null

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

      <section className="card flex flex-wrap items-center gap-3 p-3">
        <span className="text-sm text-slate-500">
          {isUnassigned ? (
            <span className="font-medium text-amber-700">Sin dueño</span>
          ) : (
            'Responsable'
          )}
        </span>

        {canWith(profile, 'ticket.reply') && (
          <button
            type="button"
            onClick={() => setAttachMode((v) => !v)}
            disabled={messages.length === 0}
            className="btn-ghost text-sm"
          >
            <Paperclip size={14} />
            {attachMode ? 'Terminar' : 'Adjuntar al ticket'}
          </button>
        )}

        {isUnassigned && (
          <button type="button" onClick={take} disabled={busy} className="btn-primary text-sm">
            <Hand size={14} />
            Tomar
          </button>
        )}

        {canReassign && agents.length > 0 && (
          <>
            <select
              value={ownerChoice}
              onChange={(e) => setOwnerChoice(e.target.value)}
              disabled={busy}
              className="input text-sm"
              aria-label="Reasignar conversación"
            >
              <option value="">Reasignar a…</option>
              <option value="__unassign__">— Devolver a la cola —</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.display_name ?? a.id.slice(0, 8)} ({a.role})
                </option>
              ))}
            </select>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Motivo de la transferencia"
              className="input text-sm"
              aria-label="Motivo de la transferencia"
            />
            <button
              type="button"
              onClick={() => {
                if (ownerChoice === '__unassign__') void reassign(null)
                else if (ownerChoice) void reassign(ownerChoice)
              }}
              disabled={busy || !ownerChoice}
              className="btn-primary text-sm"
            >
              Transferir
            </button>

            <select
              value=""
              onChange={(e) => {
                if (e.target.value) void askForHelp(e.target.value)
              }}
              disabled={busy}
              className="input text-sm"
              aria-label="Pedir apoyo"
            >
              <option value="">Pedir apoyo a…</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.display_name ?? a.id.slice(0, 8)} ({a.role})
                </option>
              ))}
            </select>
          </>
        )}

        {!canReassign && !isUnassigned && (
          <span className="inline-flex items-center gap-1 text-sm text-slate-400">
            <UserPlus size={14} />
            Pide a un supervisor que te lo reasigne
          </span>
        )}
      </section>

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
        {attachMode && (
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-brand-200 bg-brand-50 p-2">
            <span className="text-xs font-medium text-brand-800">
              {selectedMessages.size} seleccionado
              {selectedMessages.size === 1 ? '' : 's'}
            </span>
            <input
              value={attachTicket}
              onChange={(e) => setAttachTicket(e.target.value)}
              placeholder="UUID del ticket"
              className="input flex-1 font-mono text-xs"
            />
            <button
              type="button"
              onClick={() => void attachSelected()}
              disabled={busy || !attachTicket || selectedMessages.size === 0}
              className="btn-primary text-xs"
            >
              Adjuntar
            </button>
            <button
              type="button"
              onClick={() => {
                setAttachMode(false)
                setSelectedMessages(new Set())
                setAttachTicket('')
              }}
              className="btn-ghost text-xs"
            >
              Cancelar
            </button>
          </div>
        )}
        {attachError && <p className="mb-2 text-xs text-red-700">{attachError}</p>}

        <ol className="space-y-3">
          {messages.length === 0 ? (
            <li className="text-sm text-slate-500">Aún no hay mensajes.</li>
          ) : (
            messages.map((m) => (
              <Bubble
                key={m.id}
                message={m}
                attachMode={attachMode}
                selected={selectedMessages.has(m.id)}
                onToggle={() => toggleMessage(m.id)}
              />
            ))
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
            onChange={(e) => updateDraft(e.target.value)}
            rows={3}
            placeholder="Escribe tu respuesta…"
            className="input"
          />
          {sendError && (
            <p className="mt-2 text-sm text-red-700" aria-live="polite">
              {sendError}
            </p>
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

function Bubble({
  message,
  attachMode,
  selected,
  onToggle,
}: {
  message: ConversationMessage
  attachMode?: boolean
  selected?: boolean
  onToggle?: () => void
}) {
  const isInbound = message.direction === 'in'
  return (
    <li
      className={clsx(
        'flex flex-col gap-1',
        isInbound ? 'items-start' : 'items-end',
      )}
    >
      <div className="flex items-center gap-2 text-xs text-slate-500">
        {attachMode && (
          <label className="inline-flex items-center gap-1 text-brand-700">
            <input
              type="checkbox"
              checked={Boolean(selected)}
              onChange={onToggle}
              className="accent-brand-600"
              aria-label="Seleccionar mensaje para adjuntar"
            />
          </label>
        )}
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
          attachMode && selected && 'ring-2 ring-brand-400',
        )}
      >
        {message.body || '(sin contenido)'}
      </div>
    </li>
  )
}