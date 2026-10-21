import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Search, UserPlus, Users } from 'lucide-react'
import clsx from 'clsx'
import { api, ApiError } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { canWith } from '@/lib/permissions'
import type { UserWithProfile } from '@/lib/users'

export default function UsersPage() {
  const profile = useAuthStore((s) => s.profile)
  // `admin.createUser` was a catalogue key with no route behind it, so there
  // was nothing to gate. Now that POST /api/users exists, this is what decides
  // whether the button appears.
  const canCreate = canWith(profile, 'admin.createUser')

  const [users, setUsers] = useState<UserWithProfile[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

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
  }, [query, reloadKey])

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Usuarios</h1>
          <p className="mt-1 text-sm text-slate-500">
            Equipo del CRM. Cada uno con sus tickets asignados.
          </p>
        </div>
        <div className="flex items-center gap-3">
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
          {canCreate && (
            <button
              type="button"
              className="btn-primary"
              onClick={() => setCreateOpen(true)}
            >
              <UserPlus size={16} />
              Nuevo usuario
            </button>
          )}
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

      {createOpen && (
        <CreateUserModal
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false)
            // Re-run the query so the new account appears in the list.
            setReloadKey((k) => k + 1)
          }}
        />
      )}
    </div>
  )
}

/**
 * Create-user modal (issue 4).
 *
 * The account is created already confirmed with a temporary password rather
 * than by email invite: this is an internal tool, the admin is handing the
 * credentials over directly, and a confirmation email that depends on SMTP
 * being configured is a failure mode with no upside here. The password is
 * returned once and never stored — the server does not keep it either.
 */
function CreateUserModal({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: () => void
}) {
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [roleKey, setRoleKey] = useState('soporte')
  const [roles, setRoles] = useState<{ key: string; name: string }[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.get<{ data: { key: string; name: string }[] }>('/api/roles')
        setRoles(res.data.map((r) => ({ key: r.key, name: r.name })))
      } catch (err) {
        // Not fatal: the form still works, it just cannot offer custom roles.
        // eslint-disable-next-line no-console
        console.warn('[users] role list failed', err)
      }
    })()
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      await api.post('/api/users', {
        email: email.trim(),
        password,
        display_name: displayName.trim() || undefined,
        role_key: roleKey,
      })
      setCreated({ email: email.trim(), password })
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setSubmitting(false)
    }
  }

  // After a successful create, the only thing left to do is hand over the
  // credentials — so the form becomes that, instead of closing and hiding the
  // password the admin never saw again.
  if (created) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"
        onClick={onCreated}
      >
        <div className="card w-full max-w-md space-y-3 p-6" onClick={(e) => e.stopPropagation()}>
          <h2 className="text-lg font-semibold text-slate-900">Usuario creado</h2>
          <p className="text-sm text-slate-600">
            Pasale estas credenciales a <strong>{created.email}</strong>. La contraseña
            no se vuelve a mostrar.
          </p>
          <dl className="space-y-2 rounded-md bg-slate-50 p-3 text-sm">
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500">Email</dt>
              <dd className="font-mono">{created.email}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500">Contraseña</dt>
              <dd className="font-mono">{created.password}</dd>
            </div>
          </dl>
          <div className="flex justify-end">
            <button type="button" className="btn-primary" onClick={onCreated}>
              Listo
            </button>
          </div>
        </div>
      </div>
    )
  }

  const passwordTooShort = password.length > 0 && password.length < 8

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"
      onClick={onClose}
    >
      <div className="card w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-slate-900">Nuevo usuario</h2>
        <form className="mt-4 space-y-3" onSubmit={submit}>
          <div>
            <label className="text-xs font-medium text-slate-600" htmlFor="nu-email">
              Email
            </label>
            <input
              id="nu-email"
              type="email"
              required
              autoFocus
              className="input mt-1"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div>
            <label className="text-xs font-medium text-slate-600" htmlFor="nu-name">
              Nombre
            </label>
            <input
              id="nu-name"
              type="text"
              maxLength={120}
              placeholder="Opcional — puede completarlo en su perfil"
              className="input mt-1"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>

          <div>
            <label className="text-xs font-medium text-slate-600" htmlFor="nu-role">
              Rol
            </label>
            <select
              id="nu-role"
              className="input mt-1"
              value={roleKey}
              onChange={(e) => setRoleKey(e.target.value)}
            >
              {roles.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs font-medium text-slate-600" htmlFor="nu-password">
              Contraseña temporal
            </label>
            <input
              id="nu-password"
              type="text"
              required
              minLength={8}
              className="input mt-1 font-mono"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {passwordTooShort ? (
              <p className="mt-1 text-xs text-amber-700">Mínimo 8 caracteres.</p>
            ) : (
              <p className="mt-1 text-xs text-slate-500">
                Se la entregas a la persona; cámbiala al entrar.
              </p>
            )}
          </div>

          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancelar
            </button>
            <button
              type="submit"
              disabled={submitting || passwordTooShort}
              className="btn-primary"
            >
              {submitting ? 'Creando…' : 'Crear usuario'}
            </button>
          </div>
        </form>
      </div>
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