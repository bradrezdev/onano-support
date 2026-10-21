import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  AlertTriangle,
  MessageSquare,
  Ticket as TicketIcon,
  Palette,
} from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import clsx from 'clsx'
import { api, ApiError } from '@/lib/api'

interface TicketRow {
  id: string
  name: string
  status: 'open' | 'in_progress' | 'closed'
  priority: string | null
  is_major: boolean
  due_at: string | null
  updated_at: string
  category_name: string | null
  theme_name: string | null
}

interface ThemeTouch {
  theme_id: string
  theme_name: string
  ticket_count: number
}

interface ContactDetail {
  contact: {
    id: string
    whatsapp_number: string
    name: string | null
    email: string | null
    country: string | null
    country_code: string | null
    profile_pic_url: string | null
    created_at: string
  }
  tickets: TicketRow[]
  major_incidents: TicketRow[]
  conversations: Array<{
    id: string
    status: string
    last_message_at: string | null
    last_message_preview: string | null
    unread_count: number
  }>
  themes: ThemeTouch[]
  counts: {
    tickets_total: number
    tickets_open: number
    major_total: number
    conversations_total: number
  }
}

/**
 * Ficha del cliente (C2).
 *
 * Answers "who is this person and what happened with them": their tickets,
 * the ones a human flagged as major incidents, their conversation history,
 * and which themes keep coming back.
 *
 * The theme history is the point of the page. Three tickets about "pagos
 * rechazados" over a year is normal; three in a week is a pattern, and only
 * the grouped count shows it.
 */
export default function ContactDetailPage() {
  const { id = '' } = useParams<{ id: string }>()
  const [detail, setDetail] = useState<ContactDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<{ data: ContactDetail }>(
        `/api/contacts/${id}?detail=1`,
      )
      setDetail(res.data)
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (id) void load()
  }, [id])

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

  const { contact, tickets, major_incidents, conversations, themes, counts } = detail

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-2">
        <Link to="/contacts" className="btn-ghost mt-1 p-2" aria-label="Volver">
          <ArrowLeft size={16} />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold text-slate-900">
            {contact.name ?? contact.whatsapp_number}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {contact.whatsapp_number}
            {contact.email ? ` · ${contact.email}` : ''}
            {contact.country ? ` · ${contact.country}` : ''}
          </p>
        </div>
        <Link
          to={`/tickets/new?contact_id=${contact.id}`}
          className="btn-primary shrink-0 text-sm"
        >
          <TicketIcon size={14} />
          Nuevo ticket
        </Link>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Tickets abiertos" value={counts.tickets_open} />
        <Stat label="Tickets totales" value={counts.tickets_total} />
        <Stat
          label="Incidencias mayores"
          value={counts.major_total}
          tone={counts.major_total > 0 ? 'red' : 'default'}
        />
        <Stat label="Conversaciones" value={counts.conversations_total} />
      </div>

      {major_incidents.length > 0 && (
        <section className="space-y-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <span className="rounded bg-red-50 p-1 text-red-700">
              <AlertTriangle size={14} />
            </span>
            Incidencias mayores
          </h2>
          <ul className="card divide-y divide-slate-100">
            {major_incidents.map((t) => (
              <TicketListRow key={t.id} ticket={t} />
            ))}
          </ul>
        </section>
      )}

      {themes.length > 0 && (
        <section className="space-y-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <span className="rounded bg-violet-50 p-1 text-violet-700">
              <Palette size={14} />
            </span>
            Historial de temas
          </h2>
          <ul className="card divide-y divide-slate-100">
            {themes.map((t) => (
              <li key={t.theme_id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <span className="font-medium text-slate-900">{t.theme_name}</span>
                <span className="text-xs text-slate-500">
                  {t.ticket_count} ticket{t.ticket_count === 1 ? '' : 's'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {tickets.length > 0 && (
        <section className="space-y-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <span className="rounded bg-slate-100 p-1 text-slate-600">
              <TicketIcon size={14} />
            </span>
            Tickets
          </h2>
          <ul className="card divide-y divide-slate-100">
            {tickets.map((t) => (
              <TicketListRow key={t.id} ticket={t} />
            ))}
          </ul>
        </section>
      )}

      {conversations.length > 0 && (
        <section className="space-y-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <span className="rounded bg-brand-50 p-1 text-brand-700">
              <MessageSquare size={14} />
            </span>
            Conversaciones
          </h2>
          <ul className="card divide-y divide-slate-100">
            {conversations.map((c) => (
              <li key={c.id}>
                <Link
                  to={`/inbox/${c.id}`}
                  className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50"
                >
                  <div className="min-w-0 flex-1">
                    {c.last_message_preview && (
                      <div className="truncate text-sm text-slate-700">
                        {c.last_message_preview}
                      </div>
                    )}
                    <div className="text-xs text-slate-500">{c.status}</div>
                  </div>
                  {c.unread_count > 0 && (
                    <span className="shrink-0 rounded-full bg-brand-600 px-2 py-0.5 text-xs font-medium text-white">
                      {c.unread_count}
                    </span>
                  )}
                  <div className="shrink-0 text-xs text-slate-400">
                    {c.last_message_at
                      ? formatDistanceToNow(new Date(c.last_message_at), { addSuffix: true })
                      : '—'}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {tickets.length === 0 && conversations.length === 0 && (
        <div className="card p-6 text-sm text-slate-500">
          Este cliente todavía no tiene tickets ni conversaciones.
        </div>
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  tone = 'default',
}: {
  label: string
  value: number
  tone?: 'default' | 'red'
}) {
  return (
    <div className="card p-3">
      <div
        className={clsx(
          'text-2xl font-semibold leading-none',
          tone === 'red' ? 'text-red-600' : 'text-slate-900',
        )}
      >
        {value}
      </div>
      <div className="mt-1 text-xs text-slate-500">{label}</div>
    </div>
  )
}

function TicketListRow({ ticket }: { ticket: TicketRow }) {
  const overdue =
    ticket.due_at != null &&
    new Date(ticket.due_at).getTime() < Date.now() &&
    ticket.status !== 'closed'

  return (
    <li>
      <Link
        to={`/tickets/${ticket.id}`}
        className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-slate-900">{ticket.name}</span>
            {ticket.is_major && (
              <span className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                mayor
              </span>
            )}
            {ticket.priority === 'urgent' && (
              <span className="shrink-0 rounded-full bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-700">
                urgente
              </span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-slate-500">
            {ticket.category_name ?? 'Sin categoría'}
            {ticket.theme_name ? ` · ${ticket.theme_name}` : ''}
          </div>
        </div>
        <div className="shrink-0 text-right">
          {overdue && ticket.due_at && (
            <div className="text-xs font-medium text-red-600">vencido</div>
          )}
          <div className="text-xs text-slate-400">
            {formatDistanceToNow(new Date(ticket.updated_at), { addSuffix: true })}
          </div>
        </div>
      </Link>
    </li>
  )
}