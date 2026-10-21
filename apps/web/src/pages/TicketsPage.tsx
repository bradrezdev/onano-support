import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Filter, Search } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { formatDistanceToNow } from 'date-fns'

interface TicketSummary {
  id: string
  contact_id: string
  category_id: string
  assigned_to: string | null
  theme_id: string | null
  flow_id: string | null
  name: string
  status: 'open' | 'in_progress' | 'closed'
  created_at: string
  updated_at: string
  closed_at: string | null
}

interface TicketSearchHit extends TicketSummary {
  contact_email: string | null
  contact_name: string | null
  contact_country: string | null
}

const STATUS_LABEL: Record<TicketSummary['status'], string> = {
  open: 'Abierto',
  in_progress: 'En curso',
  closed: 'Cerrado',
}

const STATUS_COLOR: Record<TicketSummary['status'], string> = {
  open: 'bg-emerald-100 text-emerald-700',
  in_progress: 'bg-amber-100 text-amber-700',
  closed: 'bg-slate-200 text-slate-700',
}

export default function TicketsPage() {
  const [tickets, setTickets] = useState<TicketSummary[]>([])
  const [searchHits, setSearchHits] = useState<TicketSearchHit[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<'all' | TicketSummary['status']>('all')
  const [query, setQuery] = useState('')

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const qs = statusFilter === 'all' ? '' : `?status=${statusFilter}`
      const res = await api.get<{ data: TicketSummary[] }>(`/api/tickets${qs}`)
      setTickets(res.data)
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [statusFilter])

  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setSearchHits([])
      return
    }
    let cancelled = false
    const id = setTimeout(async () => {
      try {
        const res = await api.get<{ data: TicketSearchHit[] }>(
          `/api/tickets/search?q=${encodeURIComponent(q)}`,
        )
        if (!cancelled) setSearchHits(res.data)
      } catch {
        if (!cancelled) setSearchHits([])
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(id)
    }
  }, [query])

  const showingHits = query.trim().length > 0

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Tickets</h1>
          <p className="mt-1 text-sm text-slate-500">
            Solicitudes internas con descripción enriquecida, categoría y conversación asignada.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search
              size={16}
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-slate-400"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar por nombre, email o país…"
              className="input pl-8"
            />
          </div>
          <Link to="/tickets/new" className="btn-primary">
            <Plus size={16} />
            Nuevo ticket
          </Link>
        </div>
      </header>

      <div className="flex items-center gap-2">
        <Filter size={14} className="text-slate-400" />
        <span className="text-xs text-slate-500">Estado:</span>
        {(['all', 'open', 'in_progress', 'closed'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatusFilter(s)}
            className={
              statusFilter === s
                ? 'rounded-full bg-slate-900 px-3 py-1 text-xs font-medium text-white'
                : 'rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600 hover:bg-slate-200'
            }
          >
            {s === 'all' ? 'Todos' : STATUS_LABEL[s]}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {showingHits ? (
        showingHits
          ? searchHits.length === 0
            ? (
                <div className="card p-8 text-center text-sm text-slate-500">
                  Sin resultados para &ldquo;{query}&rdquo;.
                </div>
              )
            : (
                <div className="card overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-4 py-2 font-medium">Nombre</th>
                        <th className="px-4 py-2 font-medium">Estado</th>
                        <th className="px-4 py-2 font-medium">Cliente</th>
                        <th className="px-4 py-2 font-medium">Actualizado</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {searchHits.map((t) => (
                        <tr key={t.id} className="hover:bg-slate-50">
                          <td className="px-4 py-2 font-medium text-slate-900">
                            <Link to={`/tickets/${t.id}`} className="hover:underline">
                              {t.name}
                            </Link>
                          </td>
                          <td className="px-4 py-2">
                            <span
                              className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[t.status]}`}
                            >
                              {STATUS_LABEL[t.status]}
                            </span>
                          </td>
                          <td className="px-4 py-2 text-slate-600">
                            {t.contact_name ?? t.contact_email ?? t.contact_country ?? '—'}
                          </td>
                          <td className="px-4 py-2 text-xs text-slate-500">
                            {formatDistanceToNow(new Date(t.updated_at), {
                              addSuffix: true,
                            })}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
          : null
      ) : loading ? (
        <div className="card p-6 text-sm text-slate-500">Cargando…</div>
      ) : tickets.length === 0 ? (
        <div className="card p-8 text-center text-sm text-slate-500">
          Sin tickets con esos filtros.
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Nombre</th>
                <th className="px-4 py-2 font-medium">Estado</th>
                <th className="px-4 py-2 font-medium">Asignado</th>
                <th className="px-4 py-2 font-medium">Actualizado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {tickets.map((t) => (
                <tr key={t.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2 font-medium text-slate-900">
                    <Link to={`/tickets/${t.id}`} className="hover:underline">
                      {t.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[t.status]}`}
                    >
                      {STATUS_LABEL[t.status]}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-slate-600">
                    {t.assigned_to ? t.assigned_to.slice(0, 8) : '—'}
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-500">
                    {formatDistanceToNow(new Date(t.updated_at), { addSuffix: true })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}