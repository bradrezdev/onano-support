import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Inbox,
  AlertTriangle,
  UserPlus,
  MessageSquare,
  Clock,
  ChevronRight,
} from 'lucide-react'
import clsx from 'clsx'
import { formatDistanceToNow } from 'date-fns'
import { api, ApiError } from '@/lib/api'

interface TicketSummary {
  id: string
  name: string
  status: 'open' | 'in_progress' | 'closed'
  updated_at: string
  due_at: string | null
  contact_name: string | null
}

interface ConversationSummary {
  id: string
  contact_name: string | null
  last_message_at: string | null
  unread_count: number
}

interface InboxBucket {
  mine: { count: number; rows: TicketSummary[] }
  overdue: { count: number; rows: TicketSummary[] }
  unassigned: { count: number; rows: TicketSummary[] }
  unread: { count: number; rows: ConversationSummary[] }
}

/**
 * "Mi bandeja" (D1, recommendation 8).
 *
 * A dashboard has to answer "what do I do now". Four tiles, each linking to
 * the list behind it, no decorative gauges. A tile showing zero collapses —
 * an empty box is noise, an empty count is information.
 */
export default function DashboardPage() {
  const [data, setData] = useState<InboxBucket | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<{ data: InboxBucket }>('/api/dashboard')
      setData(res.data)
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

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
  if (!data) return null

  const totalActionable =
    data.mine.count + data.overdue.count + data.unassigned.count + data.unread.count

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">Mi bandeja</h1>
        <p className="mt-1 text-sm text-slate-500">
          {totalActionable === 0
            ? 'Nada pendiente. Buen trabajo.'
            : `${totalActionable} cosa${totalActionable === 1 ? '' : 's'} esperando por vos.`}
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          to="/tickets?assigned_to=me&status=open"
          icon={Inbox}
          label="Mis tickets"
          count={data.mine.count}
          tone="brand"
        />
        <Tile
          to="/tickets?assigned_to=me&overdue=1"
          icon={Clock}
          label="Vencidos"
          count={data.overdue.count}
          tone="red"
        />
        <Tile
          to="/tickets?assigned_to=none&status=open"
          icon={UserPlus}
          label="Sin asignar"
          count={data.unassigned.count}
          tone="amber"
        />
        <Tile
          to="/inbox"
          icon={MessageSquare}
          label="Mensajes sin abrir"
          count={data.unread.count}
          tone="violet"
        />
      </div>

      {data.overdue.count > 0 && (
        <Section
          title="Vencidos"
          icon={AlertTriangle}
          tone="red"
          to="/tickets?assigned_to=me&overdue=1"
        >
          {data.overdue.rows.map((t) => (
            <TicketRow key={t.id} ticket={t} showDue />
          ))}
        </Section>
      )}

      {data.mine.count > 0 && (
        <Section title="Mis tickets" icon={Inbox} to="/tickets?assigned_to=me&status=open">
          {data.mine.rows.map((t) => (
            <TicketRow key={t.id} ticket={t} />
          ))}
        </Section>
      )}

      {data.unassigned.count > 0 && (
        <Section
          title="Sin asignar"
          icon={UserPlus}
          tone="amber"
          to="/tickets?assigned_to=none&status=open"
          hint="Nadie los ha tomado todavía."
        >
          {data.unassigned.rows.map((t) => (
            <TicketRow key={t.id} ticket={t} />
          ))}
        </Section>
      )}

      {data.unread.count > 0 && (
        <Section title="Mensajes sin abrir" icon={MessageSquare} tone="violet" to="/inbox">
          {data.unread.rows.map((c) => (
            <li key={c.id}>
              <Link
                to={`/inbox/${c.id}`}
                className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50"
              >
                <div className="min-w-0 flex-1">
                  <span className="truncate font-medium text-slate-900">
                    {c.contact_name ?? 'Conversación'}
                  </span>
                </div>
                <span className="shrink-0 rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700">
                  {c.unread_count}
                </span>
              </Link>
            </li>
          ))}
        </Section>
      )}

      {totalActionable === 0 && (
        <div className="card p-8 text-center">
          <p className="text-sm text-slate-500">
            No tenés tickets abiertos ni mensajes sin responder.
          </p>
        </div>
      )}
    </div>
  )
}

const TONES = {
  brand: 'bg-brand-50 text-brand-700',
  red: 'bg-red-50 text-red-700',
  amber: 'bg-amber-50 text-amber-700',
  violet: 'bg-violet-50 text-violet-700',
} as const

type Tone = keyof typeof TONES

function Tile({
  to,
  icon: Icon,
  label,
  count,
  tone,
}: {
  to: string
  icon: typeof Inbox
  label: string
  count: number
  tone: Tone
}) {
  return (
    <Link
      to={to}
      className={clsx(
        'card flex items-center gap-3 p-4 transition-shadow hover:shadow-sm',
        count === 0 && 'opacity-60',
      )}
    >
      <span className={clsx('rounded-lg p-2', TONES[tone])}>
        <Icon size={18} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-2xl font-semibold leading-none text-slate-900">{count}</div>
        <div className="mt-1 truncate text-xs text-slate-500">{label}</div>
      </div>
    </Link>
  )
}

function Section({
  title,
  icon: Icon,
  tone = 'brand',
  to,
  hint,
  children,
}: {
  title: string
  icon: typeof Inbox
  tone?: Tone
  to: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <span className={clsx('rounded p-1', TONES[tone])}>
            <Icon size={14} />
          </span>
          {title}
        </h2>
        <Link
          to={to}
          className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-brand-700"
        >
          Ver todos
          <ChevronRight size={12} />
        </Link>
      </div>
      {hint && <p className="text-xs text-slate-500">{hint}</p>}
      <ul className="card divide-y divide-slate-100">{children}</ul>
    </section>
  )
}

function TicketRow({ ticket, showDue }: { ticket: TicketSummary; showDue?: boolean }) {
  const overdue =
    showDue && ticket.due_at != null && new Date(ticket.due_at).getTime() < Date.now()

  return (
    <li>
      <Link
        to={`/tickets/${ticket.id}`}
        className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50"
      >
        <div className="min-w-0 flex-1">
          <span className="truncate font-medium text-slate-900">{ticket.name}</span>
          {ticket.contact_name && (
            <span className="ml-2 text-xs text-slate-500">{ticket.contact_name}</span>
          )}
        </div>
        {overdue && ticket.due_at && (
          <span className="shrink-0 text-xs font-medium text-red-600">
            venció {formatDistanceToNow(new Date(ticket.due_at), { addSuffix: true })}
          </span>
        )}
        {!overdue && (
          <span className="shrink-0 text-xs text-slate-400">
            {formatDistanceToNow(new Date(ticket.updated_at), { addSuffix: true })}
          </span>
        )}
      </Link>
    </li>
  )
}