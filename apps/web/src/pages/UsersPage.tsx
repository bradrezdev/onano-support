import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Search, Users } from 'lucide-react'
import clsx from 'clsx'
import { api, ApiError } from '@/lib/api'
import type { UserWithProfile } from '@/lib/users'

export default function UsersPage() {
  const [users, setUsers] = useState<UserWithProfile[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const res = await api.get<{ data: UserWithProfile[] }>(
          query.trim() ? `/api/users?q=${encodeURIComponent(query.trim())}` : '/api/users',
        )
        if (!cancelled) setUsers(res.data)
      } catch (err) {
        if (!cancelled) setError((err as ApiError).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    const id = setTimeout(load, 250) // debounce search
    return () => {
      cancelled = true
      clearTimeout(id)
    }
  }, [query])

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Usuarios</h1>
          <p className="mt-1 text-sm text-slate-500">
            Equipo del CRM. Cada uno con sus tickets asignados.
          </p>
        </div>
        <div className="relative">
          <Search
            size={16}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-slate-400"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar por nombre o email…"
            className="input pl-8"
          />
        </div>
      </header>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="card p-6 text-sm text-slate-500">Cargando…</div>
      ) : users.length === 0 ? (
        <div className="card flex flex-col items-center gap-2 p-8 text-center text-sm text-slate-500">
          <Users size={32} className="text-slate-300" />
          <p>Sin resultados.</p>
        </div>
      ) : (
        <div className="card divide-y divide-slate-100">
          {users.map((u) => (
            <Link
              key={u.id}
              to={`/users/${u.id}`}
              className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50"
            >
              <Avatar name={u.display_name ?? u.email ?? '?'} />
              <div className="flex-1">
                <div className="font-medium text-slate-900">
                  {u.display_name ?? u.email ?? 'Sin nombre'}
                </div>
                <div className="text-xs text-slate-500">{u.email}</div>
              </div>
              <RoleBadge role={u.role} suspended={!!u.suspended_at} />
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

function Avatar({ name }: { name: string }) {
  const initial = name.trim().charAt(0).toUpperCase() || '?'
  return (
    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-200 text-sm font-medium text-slate-700">
      {initial}
    </div>
  )
}

function RoleBadge({ role, suspended }: { role: UserWithProfile['role']; suspended: boolean }) {
  const styles = {
    admin: 'bg-violet-100 text-violet-700',
    supervisor: 'bg-amber-100 text-amber-700',
    soporte: 'bg-sky-100 text-sky-700',
  } as const
  const labels = {
    admin: 'Admin',
    supervisor: 'Supervisor',
    soporte: 'Soporte',
  } as const
  return (
    <span className="flex items-center gap-1">
      <span
        className={clsx(
          'rounded-full px-2 py-0.5 text-xs font-medium',
          styles[role],
        )}
      >
        {labels[role]}
      </span>
      {suspended && (
        <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
          Suspendido
        </span>
      )}
    </span>
  )
}