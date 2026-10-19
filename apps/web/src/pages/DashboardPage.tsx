import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Inbox } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { api, ApiError } from '@/lib/api'
import { previewSnippet, type Conversation } from '@/lib/conversations'

/**
 * Inbox view — lists conversations ordered by last_message_at desc.
 * Mounted at /inbox (replaces the slice-0 placeholder).
 */
export default function InboxPage() {
  const [items, setItems] = useState<Conversation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<{ data: Conversation[] }>('/api/conversations')
      setItems(res.data)
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

  return (
    <div className="space-y-4">
      <header className="flex items-center gap-3">
        <Inbox size={20} className="text-slate-500" />
        <h1 className="text-2xl font-semibold text-slate-900">Inbox</h1>
        <span className="text-sm text-slate-500">({items.length})</span>
      </header>

      {items.length === 0 ? (
        <div className="card p-6 text-sm text-slate-500">
          Aún no hay conversaciones. Espera mensajes entrantes de WhatsApp o
          crea uno desde un contacto.
        </div>
      ) : (
        <ul className="card divide-y divide-slate-100">
          {items.map((c) => (
            <li key={c.id} className="px-4 py-3">
              <Link
                to={`/inbox/${c.id}`}
                className="flex items-center justify-between gap-3 hover:text-indigo-700"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-slate-900">
                      {c.contact?.name ?? c.contact?.whatsapp_number ?? 'Sin contacto'}
                    </span>
                    {c.unread_count > 0 && (
                      <span className="rounded-full bg-brand-600 px-2 py-0.5 text-xs font-medium text-white">
                        {c.unread_count}
                      </span>
                    )}
                    <StatusBadge status={c.status} />
                  </div>
                  <div className="mt-1 truncate text-xs text-slate-500">
                    {previewSnippet(c.last_message_preview)}
                  </div>
                </div>
                <div className="shrink-0 text-xs text-slate-400">
                  {c.last_message_at
                    ? formatDistanceToNow(new Date(c.last_message_at), { addSuffix: true })
                    : '—'}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: Conversation['status'] }) {
  const styles: Record<Conversation['status'], string> = {
    open: 'bg-emerald-100 text-emerald-700',
    pending: 'bg-amber-100 text-amber-700',
    closed: 'bg-slate-200 text-slate-600',
  }
  const labels: Record<Conversation['status'], string> = {
    open: 'Abierta',
    pending: 'Pendiente',
    closed: 'Cerrada',
  }
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${styles[status]}`}>
      {labels[status]}
    </span>
  )
}