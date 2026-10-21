import { useEffect, useMemo, useState } from 'react'
import { KeyRound, Plus, Trash2, Lock, Check } from 'lucide-react'
import clsx from 'clsx'
import { api, ApiError } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { canWith, type Permission } from '@/lib/permissions'
import { groupPermissions, type Role, type PermissionMeta } from '@/lib/roles'

/**
 * Role editor (R2, recommendation 1).
 *
 * Permissions are the keys; a role is the keyring. An empty keyring is allowed
 * and rendered as such — a blank badge the Admin can fill in, rather than a
 * role that mysteriously 403s later.
 */
export default function RolesPage() {
  const profile = useAuthStore((s) => s.profile)
  const canManage = canWith(profile, 'admin.manageRoles')

  const [roles, setRoles] = useState<Role[]>([])
  const [catalog, setCatalog] = useState<PermissionMeta[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState({ key: '', name: '', color: '#0ea5e9', description: '' })

  const groups = useMemo(() => groupPermissions(catalog), [catalog])
  const selected = roles.find((r) => r.id === selectedId) ?? null

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<{ data: Role[]; catalog: PermissionMeta[] }>('/api/roles')
      setRoles(res.data)
      setCatalog(res.catalog)
      setSelectedId((prev) => prev ?? res.data[0]?.id ?? null)
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function savePermissions(roleId: string, permissions: Permission[]) {
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      await api.patch(`/api/roles/${roleId}`, { permissions })
      const res = await api.get<{ data: Role[]; catalog: PermissionMeta[] }>('/api/roles')
      setRoles(res.data)
      setNotice('Permisos guardados')
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setSaving(false)
    }
  }

  async function createRole() {
    setSaving(true)
    setError(null)
    try {
      const res = await api.post<{ data: Role }>('/api/roles', {
        key: draft.key,
        name: draft.name,
        color: draft.color,
        description: draft.description || null,
        permissions: [],
      })
      const list = await api.get<{ data: Role[] }>('/api/roles')
      setRoles(list.data)
      setSelectedId(res.data.id)
      setCreating(false)
      setDraft({ key: '', name: '', color: '#0ea5e9', description: '' })
      setNotice('Rol creado. Ahora dale sus permisos.')
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setSaving(false)
    }
  }

  async function removeRole(role: Role) {
    if (!confirm(`¿Eliminar el rol "${role.name}"?`)) return
    setSaving(true)
    setError(null)
    try {
      await api.del(`/api/roles/${role.id}`)
      const list = await api.get<{ data: Role[] }>('/api/roles')
      setRoles(list.data)
      setSelectedId(list.data[0]?.id ?? null)
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setSaving(false)
    }
  }

  function toggle(key: Permission) {
    if (!selected || !canManage) return
    const current = new Set<Permission>(selected.permissions)
    if (current.has(key)) current.delete(key)
    else current.add(key)
    void savePermissions(selected.id, [...current])
  }

  if (loading) {
    return <div className="card p-6 text-sm text-slate-500">Cargando…</div>
  }

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-slate-900">
            <KeyRound size={20} className="text-slate-500" />
            Roles y permisos
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Los permisos son las llaves; cada rol es un llavero. Un rol sin
            llaves no puede hacer nada — y eso se ve de entrada.
          </p>
        </div>
        {canManage && !creating && (
          <button type="button" onClick={() => setCreating(true)} className="btn-primary text-sm">
            <Plus size={14} />
            Nuevo rol
          </button>
        )}
      </header>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {notice}
        </div>
      )}

      {creating && (
        <section className="card space-y-3 p-4">
          <h2 className="text-sm font-semibold text-slate-900">Nuevo rol</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-medium text-slate-600">
              Clave
              <input
                value={draft.key}
                onChange={(e) => setDraft({ ...draft, key: e.target.value })}
                placeholder="auditor"
                className="input mt-1 font-mono text-sm"
              />
              <span className="mt-1 block text-xs text-slate-400">
                minúscula, sin espacios. No se puede cambiar después.
              </span>
            </label>
            <label className="text-xs font-medium text-slate-600">
              Nombre
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="Auditor"
                className="input mt-1 text-sm"
              />
            </label>
            <label className="text-xs font-medium text-slate-600">
              Color
              <input
                type="color"
                value={draft.color}
                onChange={(e) => setDraft({ ...draft, color: e.target.value })}
                className="input mt-1 h-9 w-20 p-1"
              />
            </label>
            <label className="text-xs font-medium text-slate-600">
              Descripción
              <input
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                placeholder="Revisa casos sin tocarlos"
                className="input mt-1 text-sm"
              />
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost text-sm" onClick={() => setCreating(false)}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn-primary text-sm"
              disabled={saving || !draft.key || !draft.name}
              onClick={() => void createRole()}
            >
              Crear
            </button>
          </div>
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        <ul className="card divide-y divide-slate-100 self-start">
          {roles.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => setSelectedId(r.id)}
                className={clsx(
                  'flex w-full items-start justify-between gap-2 px-4 py-3 text-left transition-colors',
                  r.id === selectedId ? 'bg-brand-50' : 'hover:bg-slate-50',
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: r.color }}
                    />
                    <span className="truncate font-medium text-slate-900">{r.name}</span>
                    {r.is_system && (
                      <Lock size={12} className="shrink-0 text-slate-400" aria-label="Rol del sistema" />
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-slate-500">
                    {r.permissions.length} permiso{r.permissions.length === 1 ? '' : 's'} ·{' '}
                    {r.user_count} usuario{r.user_count === 1 ? '' : 's'}
                  </div>
                </div>
                {canManage && !r.is_system && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation()
                      void removeRole(r)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.stopPropagation()
                        void removeRole(r)
                      }
                    }}
                    className="shrink-0 rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                    aria-label={`Eliminar ${r.name}`}
                  >
                    <Trash2 size={14} />
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>

        {selected && (
          <section className="card space-y-4 p-4">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h2 className="font-semibold text-slate-900">{selected.name}</h2>
                <p className="font-mono text-xs text-slate-500">{selected.key}</p>
              </div>
              {selected.is_system && (
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                  Rol del sistema
                </span>
              )}
            </div>

            {selected.permissions.length === 0 && (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                Este rol no tiene ninguna llave: no puede hacer nada todavía.
              </p>
            )}

            {groups.map(({ group, items }) => (
              <div key={group}>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {group}
                </h3>
                <ul className="grid gap-1.5 sm:grid-cols-2">
                  {items.map((p) => {
                    const held = selected.permissions.includes(p.key)
                    return (
                      <li key={p.key}>
                        <button
                          type="button"
                          disabled={!canManage || saving}
                          onClick={() => toggle(p.key)}
                          className={clsx(
                            'flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-sm transition-colors',
                            held
                              ? 'border-brand-300 bg-brand-50 text-brand-800'
                              : 'border-slate-200 text-slate-600 hover:bg-slate-50',
                            (!canManage || saving) && 'cursor-not-allowed opacity-70',
                          )}
                        >
                          <span
                            className={clsx(
                              'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                              held ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300',
                            )}
                          >
                            {held && <Check size={11} />}
                          </span>
                          {p.label}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  )
}