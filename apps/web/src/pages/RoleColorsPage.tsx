import { useEffect, useState } from 'react'
import { Check, Palette } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { canWith } from '@/lib/permissions'
import { loadRoleColors } from '@/lib/roleColors'
import type { Role } from '@/lib/roles'

/** The only slugs `role_color_settings` can hold — see SHIPPED_ROLE_KEYS. */
const SHIPPED = ['admin', 'supervisor', 'soporte'] as const

interface Row {
  role: Role
  hex: string
  fade: number
  saving: boolean
  saved: boolean
  error: string | null
}

/**
 * Role colors.
 *
 * A role's color lives in two tables — `roles.color` (badges, swatches) and
 * `role_color_settings.base_color` (the CSS vars behind message bubbles) — and
 * they used to drift apart. The server now writes both on every edit, so this
 * page only has to say which table a given role reaches.
 *
 * A custom role reaches only `roles`: role_color_settings is keyed by the three
 * shipped slugs because that is what the bubbles key off. Saying so beats
 * showing a color that looks live and is not.
 */
export default function RoleColorsPage() {
  const profile = useAuthStore((s) => s.profile)
  const canManage = canWith(profile, 'admin.manageRoles')

  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<{ data: Role[] }>('/api/roles')
      setRows(
        res.data.map((role) => ({
          role,
          hex: role.color,
          // fade_steps only applies to shipped roles; the default matches the
          // seeded value so the control starts somewhere sensible.
          fade: 5,
          saving: false,
          saved: false,
          error: null,
        })),
      )
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (canManage) void load()
  }, [canManage])

  function patchRow(roleId: string, patch: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.role.id === roleId ? { ...r, ...patch } : r)))
  }

  async function save(row: Row) {
    patchRow(row.role.id, { saving: true, saved: false, error: null })
    try {
      if (SHIPPED.includes(row.role.key as (typeof SHIPPED)[number])) {
        // Goes to role_color_settings; the service mirrors it into roles.color.
        await api.put('/api/role-colors', {
          role: row.role.key,
          base_color: row.hex,
          fade_steps: row.fade,
        })
        // Re-apply the CSS vars so the change is visible without a reload.
        await loadRoleColors(true)
      } else {
        await api.patch(`/api/roles/${row.role.id}`, { color: row.hex })
      }
      patchRow(row.role.id, { saved: true, hex: row.hex })
    } catch (err) {
      patchRow(row.role.id, { error: (err as ApiError).message })
    } finally {
      patchRow(row.role.id, { saving: false })
    }
  }

  if (!canManage) {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
        Necesitás el permiso <code>admin.manageRoles</code> para editar colores.
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <header className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-100 text-brand-700">
          <Palette size={18} />
        </div>
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Colores de rol</h1>
          <p className="mt-1 text-sm text-slate-500">
            Un solo color por rol, sincronizado en badges y burbujas.
          </p>
        </div>
      </header>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="card p-6 text-sm text-slate-500">Cargando…</div>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => {
            const isShipped = SHIPPED.includes(row.role.key as (typeof SHIPPED)[number])
            const dirty = row.hex !== row.role.color
            return (
              <div key={row.role.id} className="card space-y-3 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span
                      className="inline-block h-4 w-4 rounded-full border border-slate-200"
                      style={{ backgroundColor: row.hex }}
                      aria-hidden
                    />
                    <span className="font-medium text-slate-900">{row.role.name}</span>
                    <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                      {row.role.key}
                    </code>
                  </div>
                  {row.saved && !row.error && (
                    <span className="flex items-center gap-1 text-xs text-emerald-700">
                      <Check size={12} />
                      Guardado
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <input
                    type="color"
                    aria-label={`Color de ${row.role.name}`}
                    className="h-9 w-14 cursor-pointer rounded border border-slate-300"
                    value={row.hex}
                    onChange={(e) =>
                      patchRow(row.role.id, { hex: e.target.value, saved: false })
                    }
                  />
                  <input
                    type="text"
                    aria-label={`Hex de ${row.role.name}`}
                    className="input w-28 font-mono text-sm"
                    value={row.hex}
                    onChange={(e) =>
                      patchRow(row.role.id, { hex: e.target.value, saved: false })
                    }
                  />

                  {isShipped && (
                    <label className="flex items-center gap-2 text-xs text-slate-600">
                      Desvanecido
                      <input
                        type="number"
                        min={1}
                        max={10}
                        className="input w-16 text-sm"
                        value={row.fade}
                        onChange={(e) =>
                          patchRow(row.role.id, {
                            fade: Number(e.target.value) || 1,
                            saved: false,
                          })
                        }
                      />
                    </label>
                  )}

                  <button
                    type="button"
                    className="btn-primary ml-auto text-sm"
                    disabled={row.saving || !dirty}
                    onClick={() => void save(row)}
                  >
                    {row.saving ? 'Guardando…' : 'Guardar'}
                  </button>
                </div>

                <p className="text-xs text-slate-500">
                  {isShipped
                    ? 'Se escribe en roles.color y role_color_settings.base_color.'
                    : 'Se escribe solo en roles.color: la tabla role_color_settings cubre únicamente los tres roles del sistema.'}
                </p>

                {row.error && (
                  <p className="rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">
                    {row.error}
                  </p>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}