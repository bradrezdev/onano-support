import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Trash2, Undo2 } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { api, ApiError } from '@/lib/api'

interface TrashedTicket {
  id: string
  name: string
  status: 'open' | 'in_progress' | 'closed'
  deleted_at: string
  deleted_by: string | null
  updated_at: string
}

/**
 * Papelera (recommendation 3). Nothing is ever really deleted: a ticket moves
 * here and an Admin can bring it back.
 */
export default function TrashPage() {
  const [items, setItems] = useState<TrashedTicket[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<{ data: TrashedTicket[] }>('/api/tickets/trash')
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

  async function restore(id: string) {
    setBusyId(id)
    setError(null)
    try {
      await api.post(`/api/tickets/${id}/restore`)
      await load()
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-4">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-semibold text-slate-900">
          <Trash2 size={20} className="text-slate-500" />
          Papelera
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Tickets enviados a la papelera. Nada se borra de forma irreversible:
          aquí se pueden restaurar con su historial intacto.
        </p>
      </header>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="card p-6 text-sm text-slate-500">Cargando…</div>
      ) : items.length === 0 ? (
        <div className="card p-6 text-sm text-slate-500">La papelera está vacía.</div>
      ) : (
        <ul className="card divide-y divide-slate-100">
          {items.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <Link
                  to={`/tickets/${t.id}`}
                  className="truncate font-medium text-slate-900 hover:text-brand-700"
                >
                  {t.name}
                </Link>
                <div className="mt-0.5 text-xs text-slate-500">
                  En la papelera{' '}
                  {formatDistanceToNow(new Date(t.deleted_at), { addSuffix: true })}
                  {t.deleted_by ? ` · por ${t.deleted_by.slice(0, 8)}` : ''}
                </div>
              </div>
              <button
                type="button"
                onClick={() => restore(t.id)}
                disabled={busyId === t.id}
                className="btn-ghost shrink-0 text-sm"
              >
                <Undo2 size={14} />
                Restaurar
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}