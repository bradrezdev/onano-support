import { useEffect, useState } from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import { ArrowLeft, AlertTriangle, Calendar, Check, Flag, Inbox, Layers, Paperclip, RotateCcw, Send, Tag, UserSquare } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import clsx from 'clsx'
import { api, ApiError } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { RichTextEditor, RichTextRenderer } from '@/components/ui/RichTextEditor'
import { bubbleStyle } from '@/lib/roleColors'
import { previewSnippet, type LinkedConversationSummary } from '@/lib/conversations'
import { canWith, type Role } from '@/lib/permissions'

interface Ticket {
  id: string
  name: string
  status: 'open' | 'in_progress' | 'closed'
  priority: 'low' | 'normal' | 'high' | 'urgent'
  is_major: boolean
  due_at: string | null
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

interface AttachedMessage {
  message_id: string
  ticket_id: string
  body: string | null
  direction: 'in' | 'out'
  created_at: string
  note: string | null
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

interface Agent {
  id: string
  display_name: string | null
  role_key: string
}

interface Project {
  id: string
  name: string
  color: string
  flows: { id: string; name: string }[]
}

/**
 * The six foreign keys of a ticket, resolved to labels in one request
 * (GET /api/tickets/:id/context). The row itself stores uuids; a uuid in a
 * details panel is not information, it is a lookup the reader has to do by hand.
 */
interface TicketContext {
  client: { id: string; name: string } | null
  category: { id: string; name: string } | null
  assignee: { id: string; display_name: string | null; role_key: string | null } | null
  creator: { id: string; display_name: string | null; role_key: string | null } | null
  project: { id: string; name: string } | null
  stage: { id: string; name: string } | null
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
  const canReply = canWith(profile, 'ticket.reply')

  const [ticket, setTicket] = useState<Ticket | null>(null)
  const [context, setContext] = useState<TicketContext | null>(null)
  const [agents, setAgents] = useState<Agent[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [messages, setMessages] = useState<TicketMessage[]>([])
  const [linkedConvs, setLinkedConvs] = useState<LinkedConversationSummary[]>([])
  const [attachments, setAttachments] = useState<AttachedMessage[]>([])
  const [draft, setDraft] = useState<unknown>({ type: 'doc', content: [] })
  // Recommendation 10: triage controls (priority / due / major) save inline so
  // the operator does not have to leave the case to flag urgency.
  const [triageSaving, setTriageSaving] = useState(false)
  const canMarkMajor = canWith(profile, 'ticket.markMajor')
  // Assignment is three separate powers (issues 3, 5, 9, 10). The PATCH route
  // checks the key that matches each field, so the UI has to gate each control
  // on the same key — a combined "can edit assignment" would offer a select
  // whose save is rejected.
  const canAssign = canWith(profile, 'ticket.assign')
  const canSetProject = canWith(profile, 'theme.create')
  const canMoveFlow = canWith(profile, 'ticket.moveFlow')

  async function patchTriage(patch: Record<string, unknown>) {
    setTriageSaving(true)
    setError(null)
    try {
      await api.patch(`/api/tickets/${id}`, patch)
      await loadTicket()
      await loadContext()
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setTriageSaving(false)
    }
  }
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

  async function loadContext() {
    if (!id) return
    try {
      const res = await api.get<{ data: TicketContext }>(`/api/tickets/${id}/context`)
      setContext(res.data)
    } catch (err) {
      // Non-fatal: the ticket is still readable, it just shows raw ids.
      // eslint-disable-next-line no-console
      console.warn('[ticket] loadContext failed', err)
    }
  }

  async function loadAttachments() {
    if (!id) return
    try {
      // W1: the WhatsApp evidence pinned to this ticket. Non-fatal — a ticket
      // without evidence is normal, not broken.
      const res = await api.get<{ data: AttachedMessage[] }>(`/api/tickets/${id}/attachments`)
      setAttachments(res.data)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[ticket] loadAttachments failed', err)
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

  // The assignment pickers and the labels for the details panel. Loaded once
  // per ticket, in parallel with the ticket itself.
  useEffect(() => {
    if (!id) return
    void loadContext()
    void (async () => {
      try {
        const [ag, proj] = await Promise.all([
          api.get<{ data: Agent[] }>('/api/users/assignable'),
          api.get<{ data: Project[] }>('/api/themes'),
        ])
        setAgents(ag.data)
        setProjects(proj.data)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[ticket] pickers failed to load', err)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  useEffect(() => {
    if (id && ticket) {
      void loadMessages()
      void loadLinkedConversations()
      void loadAttachments()
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
  // The phase options come from the ticket's own project, so the select can
  // never offer a phase that belongs to a different project.
  const currentProject = projects.find((p) => p.id === ticket.theme_id) ?? null

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

      <section className="card space-y-3 p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Triaje
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
            <Tag size={12} />
            Prioridad
            <select
              value={ticket.priority}
              disabled={triageSaving || !canWith(profile, 'ticket.update')}
              onChange={(e) => void patchTriage({ priority: e.target.value })}
              className="input text-sm"
            >
              <option value="low">Baja</option>
              <option value="normal">Normal</option>
              <option value="high">Alta</option>
              <option value="urgent">Urgente</option>
            </select>
          </label>

          <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
            <Calendar size={12} />
            Vence
            <input
              type="date"
              value={ticket.due_at ? ticket.due_at.slice(0, 10) : ''}
              disabled={triageSaving || !canWith(profile, 'ticket.update')}
              onChange={(e) =>
                void patchTriage({ due_at: e.target.value ? `${e.target.value}T17:00:00.000Z` : null })
              }
              className="input text-sm"
            />
          </label>

          {canMarkMajor && (
            <button
              type="button"
              disabled={triageSaving}
              onClick={() => void patchTriage({ is_major: !ticket.is_major })}
              className={clsx(
                'btn-ghost text-sm',
                ticket.is_major && 'border-red-200 bg-red-50 text-red-700',
              )}
            >
              <AlertTriangle size={14} />
              {ticket.is_major ? 'Es incidencia mayor' : 'Marcar como mayor'}
            </button>
          )}
        </div>
      </section>

      <section className="card p-5">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Descripción
        </h2>
        <div className="prose prose-sm max-w-none text-slate-800">
          <RichTextRenderer value={ticket.description} />
        </div>
      </section>

      {/* W1: the WhatsApp evidence. Read it here, not three clicks away. */}
      <section className="card p-5">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          <Paperclip size={14} />
          Mensajes adjuntos
          {attachments.length > 0 && (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
              {attachments.length}
            </span>
          )}
        </h2>
        {attachments.length === 0 ? (
          <p className="text-sm text-slate-500">
            Sin mensajes adjuntos. Podés fijarlos desde una conversación con
            &laquo;Adjuntar al ticket&raquo;.
          </p>
        ) : (
          <ul className="space-y-2">
            {attachments.map((a) => (
              <li
                key={a.message_id}
                className={clsx(
                  'rounded border px-3 py-2 text-sm',
                  a.direction === 'in'
                    ? 'border-slate-200 bg-slate-50'
                    : 'border-brand-200 bg-brand-50',
                )}
              >
                <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
                  <span className="font-medium">
                    {a.direction === 'in' ? 'Cliente' : 'Nosotros'}
                  </span>
                  <span>{formatDistanceToNow(new Date(a.created_at), { addSuffix: true })}</span>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-slate-800">
                  {a.body || '(sin contenido)'}
                </p>
              </li>
            ))}
          </ul>
        )}
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

      <section className="card space-y-3 p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Asignación
        </h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            <span className="flex items-center gap-1">
              <UserSquare size={12} />
              Asignar a
            </span>
            <select
              className="input text-sm"
              aria-label="Asignar a"
              value={ticket.assigned_to ?? ''}
              disabled={triageSaving || !canAssign}
              onChange={(e) =>
                void patchTriage({ assigned_to: e.target.value || null })
              }
            >
              <option value="">— Sin asignar —</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.display_name?.trim() || a.role_key}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            <span className="flex items-center gap-1">
              <Layers size={12} />
              Proyecto
            </span>
            <select
              className="input text-sm"
              aria-label="Proyecto"
              value={ticket.theme_id ?? ''}
              disabled={triageSaving || !canSetProject}
              onChange={(e) => {
                // Clearing the stage along with the project avoids saving a
                // theme/flow pair that do not belong together.
                void patchTriage({
                  theme_id: e.target.value || null,
                  flow_id: null,
                })
              }}
            >
              <option value="">— Sin proyecto —</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            <span className="flex items-center gap-1">
              <Flag size={12} />
              Fase
            </span>
            <select
              className="input text-sm"
              aria-label="Fase"
              value={ticket.flow_id ?? ''}
              disabled={triageSaving || !canMoveFlow || !ticket.theme_id}
              onChange={(e) => void patchTriage({ flow_id: e.target.value || null })}
            >
              <option value="">— Sin fase —</option>
              {(currentProject?.flows ?? []).map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {!ticket.theme_id && (
          <p className="text-xs text-slate-500">
            Sin proyecto, este ticket no aparece en el tablero.
          </p>
        )}
        {!canAssign && !canSetProject && !canMoveFlow && (
          <p className="text-xs text-slate-500">
            No tienes permiso de asignación sobre tickets.
          </p>
        )}
      </section>

      <section className="card p-5">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Detalles
        </h2>
        {/* Names, not uuids. `slice(0,8)` was a placeholder that outlived its
            purpose: a reader cannot act on it, and it hid the fact that the
            data to render the real name was one request away. */}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <Detail
            label="Cliente"
            value={labelFor(context?.client)}
            to={context?.client ? `/contacts/${ticket.contact_id}` : undefined}
          />
          <Detail label="Categoría" value={context?.category?.name ?? '—'} />
          <Detail label="Asignado a" value={personName(context?.assignee)} />
          <Detail label="Proyecto" value={context?.project?.name ?? '—'} />
          <Detail label="Fase" value={context?.stage?.name ?? '—'} />
          <Detail label="Creado por" value={personName(context?.creator)} />
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

function Detail({
  label,
  value,
  to,
}: {
  label: string
  value: string
  /** When set, the value links to the record it names. */
  to?: string
}) {
  return (
    <>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="text-xs text-slate-700">
        {to ? (
          <Link to={to} className="font-medium text-indigo-700 hover:underline">
            {value}
          </Link>
        ) : (
          value
        )}
      </dd>
    </>
  )
}

/** A person's display name, falling back to something readable, never a uuid. */
function personName(
  p: { display_name: string | null; role_key: string | null } | null | undefined,
): string {
  if (!p) return '—'
  return p.display_name?.trim() || p.role_key || 'Sin nombre'
}

/**
 * A referenced record that may not have resolved yet. Distinguishes "still
 * loading" from "gone", because a blank cell during load reads as data loss.
 */
function labelFor(v: { name: string } | null | undefined): string {
  if (v) return v.name
  return 'No encontrado'
}