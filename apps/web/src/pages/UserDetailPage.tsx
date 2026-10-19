import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Pause, Play } from 'lucide-react'
import clsx from 'clsx'
import { api, ApiError } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import type { UserWithCounts } from '@/lib/users'
import type { Role } from '@/lib/permissions'

interface Ticket {
  id: string
  name: string
  status: 'open' | 'in_progress' | 'closed'
  assigned_to: string | null
  theme_id: string | null
  flow_id: string | null
  updated_at: string
}

const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: 'admin', label: 'Admin' },
  { value: 'supervisor', label: 'Supervisor' },
  { value: 'soporte', label: 'Soporte' },
]

export default function UserDetailPage() {
  const { id = '' } = useParams<{ id: string }>()
  const profile = useAuthStore((s) => s.profile)
  const isAdmin = profile?.role === 'admin'
  const isSelf = profile?.id === id

  const [user, setUser] = useState<UserWithCounts | null>(null)
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [u, t] = await Promise.all([
        api.get<{ data: UserWithCounts }>(`/api/users/${id}`),
        api.get<{ data: Ticket[] }>(`/api/tickets?assigned_to=${id}&limit=50`),
      ])
      setUser(u.data)
      setTickets(t.data)
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    async function run() {
      if (cancelled) return
      await load()
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [id])

  async function patchUser(body: { role?: Role; suspend?: boolean }) {
    setBusy(true)
    setActionError(null)
    try {
      const res = await api.patch<{ data: UserWithCounts }>(`/api/users/${id}`, body)
      setUser(res.data)
    } catch (err) {
      setActionError((err as ApiError).message)
    } finally {
      setBusy(false)
    }
  }

  function changeRole(next: Role) {
    if (!user || next === user.role) return
    if (
      !confirm(
        `Cambiar rol de ${user.display_name ?? user.email} a "${ROLE_OPTIONS.find((r) => r.value === next)?.label}"?`,
      )
    ) {
      return
    }
    void patchUser({ role: next })
  }

  function toggleSuspend() {
    if (!user) return
    const willSuspend = user.suspended_at === null
    if (
      !confirm(
        willSuspend
          ? `Suspender a ${user.display_name ?? user.email}? No podrá iniciar sesión.`
          : `Reactivar a ${user.display_name ?? user.email}?`,
      )
    ) {
      return
    }
    void patchUser({ suspend: willSuspend })
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

  if (!user) return null

  const initial = (user.display_name ?? user.email ?? '?').charAt(0).toUpperCase()
  const suspended = user.suspended_at !== null
  const showAdminPanel = isAdmin && !isSelf

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Link to="/users" className="btn-ghost p-2" aria-label="Volver">
          <ArrowLeft size={16} />
        </Link>
        <h1 className="text-2xl font-semibold text-slate-900">
          {user.display_name ?? user.email}
        </h1>
        {suspended && (
          <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
            Suspendido
          </span>
        )}
      </div>

      <div className="card flex items-center gap-4 p-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-200 text-base font-medium text-slate-700">
          {initial}
        </div>
        <div className="flex-1">
          <div className="text-sm font-medium text-slate-900">
            {user.display_name ?? 'Sin nombre'}
          </div>
          <div className="text-xs text-slate-500">{user.email}</div>
          <div className="mt-1 text-xs text-slate-400">
            Rol: <span className="font-medium">{user.role}</span>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-4 text-center text-xs">
          <div>
            <div className="text-base font-semibold text-slate-900">
              {user.open_count}
            </div>
            <div className="text-slate-500">Abiertos</div>
          </div>
          <div>
            <div className="text-base font-semibold text-slate-900">
              {user.closed_count}
            </div>
            <div className="text-slate-500">Cerrados</div>
          </div>
          <div>
            <div className="text-base font-semibold text-slate-900">
              {user.total_count}
            </div>
            <div className="text-slate-500">Total</div>
          </div>
        </div>
      </div>

      {showAdminPanel && (
        <section className="card space-y-3 p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Administración
          </h2>
          {actionError && (
            <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {actionError}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-xs font-medium text-slate-600" htmlFor="role-select">
              Rol
            </label>
            <select
              id="role-select"
              value={user.role}
              disabled={busy}
              onChange={(e) => changeRole(e.target.value as Role)}
              className="input w-auto"
            >
              {ROLE_OPTIONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={toggleSuspend}
              disabled={busy}
              className="btn-ghost text-sm"
            >
              {suspended ? <Play size={14} /> : <Pause size={14} />}
              {suspended ? 'Reactivar' : 'Suspender'}
            </button>
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold text-slate-700">
          Tickets asignados ({tickets.length})
        </h2>
        {tickets.length === 0 ? (
          <div className="card p-6 text-sm text-slate-500">
            Aún no tiene tickets asignados.
          </div>
        ) : (
          <ul className="card divide-y divide-slate-100">
            {tickets.map((t) => (
              <li key={t.id} className="px-4 py-3">
                <Link
                  to={`/tickets/${t.id}`}
                  className="flex items-center justify-between gap-3 hover:text-indigo-700"
                >
                  <span className="truncate font-medium text-slate-900">
                    {t.name}
                  </span>
                  <StatusBadge status={t.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function StatusBadge({ status }: { status: Ticket['status'] }) {
  const styles = {
    open: 'bg-sky-100 text-sky-700',
    in_progress: 'bg-amber-100 text-amber-700',
    closed: 'bg-slate-100 text-slate-600',
  } as const
  const labels = { open: 'Abierto', in_progress: 'En progreso', closed: 'Cerrado' } as const
  return (
    <span
      className={clsx(
        'rounded-full px-2 py-0.5 text-xs font-medium',
        styles[status],
      )}
    >
      {labels[status]}
    </span>
  )
}