import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Palette, Pencil, Trash2, ArrowRight, GripVertical } from 'lucide-react'
import clsx from 'clsx'
import { useAuthStore } from '@/stores/auth'
import { api, ApiError } from '@/lib/api'
import type { ThemeWithFlows } from '@/lib/themes'

export default function ThemesPage() {
  const profile = useAuthStore((s) => s.profile)
  const isAdmin = profile?.role === 'admin'

  const [themes, setThemes] = useState<ThemeWithFlows[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<ThemeWithFlows | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<{ data: ThemeWithFlows[] }>('/api/themes')
      setThemes(res.data)
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function handleDelete(theme: ThemeWithFlows) {
    if (theme.flows.length > 0) {
      alert(
        `"${theme.name}" tiene ${theme.flows.length} flujo(s). Elimínalos primero.`,
      )
      return
    }
    if (
      !confirm(
        `¿Eliminar el tema "${theme.name}"? Esta acción no se puede deshacer.`,
      )
    )
      return
    try {
      await api.del(`/api/themes/${theme.id}`)
      await load()
    } catch (err) {
      alert((err as ApiError).message)
    }
  }

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Temas</h1>
          <p className="mt-1 text-sm text-slate-500">
            Cada tema agrupa flujos por los que se mueven los tickets.
          </p>
        </div>
        {isAdmin && (
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              setEditing(null)
              setFormOpen(true)
            }}
          >
            <Plus size={16} />
            Nuevo tema
          </button>
        )}
      </header>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="card p-6 text-sm text-slate-500">Cargando…</div>
      ) : themes.length === 0 ? (
        <div className="card flex flex-col items-center gap-2 p-8 text-center text-sm text-slate-500">
          <Palette size={32} className="text-slate-300" />
          <p>Aún no hay temas.</p>
          {isAdmin && (
            <button
              type="button"
              className="btn-primary mt-2"
              onClick={() => {
                setEditing(null)
                setFormOpen(true)
              }}
            >
              Crear el primero
            </button>
          )}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {themes.map((theme) => (
            <ThemeCard
              key={theme.id}
              theme={theme}
              isAdmin={isAdmin}
              onEdit={() => {
                setEditing(theme)
                setFormOpen(true)
              }}
              onDelete={() => handleDelete(theme)}
            />
          ))}
        </div>
      )}

      {formOpen && (
        <ThemeFormModal
          editing={editing}
          onClose={() => setFormOpen(false)}
          onSaved={async () => {
            setFormOpen(false)
            await load()
          }}
        />
      )}
    </div>
  )
}

function ThemeCard({
  theme,
  isAdmin,
  onEdit,
  onDelete,
}: {
  theme: ThemeWithFlows
  isAdmin: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <div className="card flex flex-col p-4">
      <div className="flex items-start gap-2">
        <span
          className="mt-1 inline-block h-4 w-4 shrink-0 rounded-full border border-slate-200"
          style={{ backgroundColor: theme.color }}
          aria-hidden
        />
        <div className="flex-1">
          <div className="font-medium text-slate-900">{theme.name}</div>
          {theme.description && (
            <div className="mt-0.5 text-xs text-slate-500">
              {theme.description}
            </div>
          )}
        </div>
        {isAdmin && (
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              className="btn-ghost p-1"
              onClick={onEdit}
              title="Editar"
              aria-label="Editar tema"
            >
              <Pencil size={14} />
            </button>
            <button
              type="button"
              className="btn-ghost p-1 text-slate-400 hover:text-red-600"
              onClick={onDelete}
              title="Eliminar"
              aria-label="Eliminar tema"
            >
              <Trash2 size={14} />
            </button>
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3 text-xs text-slate-500">
        <span className="inline-flex items-center gap-1">
          <GripVertical size={12} />
          {theme.flows.length} flujo{theme.flows.length === 1 ? '' : 's'}
        </span>
        <Link
          to={`/themes/${theme.id}`}
          className="inline-flex items-center gap-1 font-medium text-indigo-600 hover:text-indigo-700"
        >
          Editar flujos
          <ArrowRight size={12} />
        </Link>
      </div>

      {theme.flows.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {theme.flows.slice(0, 4).map((flow) => (
            <li
              key={flow.id}
              className={clsx(
                'rounded-full px-2 py-0.5 text-xs',
                flow.is_terminal
                  ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
                  : 'bg-slate-100 text-slate-600',
              )}
            >
              {flow.name}
              {flow.is_terminal && ' ✓'}
            </li>
          ))}
          {theme.flows.length > 4 && (
            <li className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
              +{theme.flows.length - 4}
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

function ThemeFormModal({
  editing,
  onClose,
  onSaved,
}: {
  editing: ThemeWithFlows | null
  onClose: () => void
  onSaved: () => void | Promise<void>
}) {
  const [name, setName] = useState(editing?.name ?? '')
  const [description, setDescription] = useState(editing?.description ?? '')
  const [color, setColor] = useState(editing?.color ?? '#6366f1')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      if (editing) {
        await api.patch(`/api/themes/${editing.id}`, {
          name: name.trim(),
          description: description.trim() || null,
          color,
        })
      } else {
        await api.post('/api/themes', {
          name: name.trim(),
          description: description.trim() || null,
          color,
        })
      }
      await onSaved()
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-md p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-slate-900">
          {editing ? `Editar "${editing.name}"` : 'Nuevo tema'}
        </h2>
        <form className="mt-4 space-y-3" onSubmit={submit}>
          <div>
            <label className="text-xs font-medium text-slate-600">Nombre</label>
            <input
              type="text"
              required
              maxLength={120}
              autoFocus
              className="input mt-1"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600">
              Descripción (opcional)
            </label>
            <textarea
              className="input mt-1 min-h-[60px]"
              maxLength={500}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600">Color</label>
            <div className="mt-1 flex items-center gap-2">
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="h-9 w-12 cursor-pointer rounded border border-slate-200"
                aria-label="Color del tema"
              />
              <input
                type="text"
                pattern="^#[0-9a-fA-F]{6}$"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="input w-28 font-mono text-xs"
              />
            </div>
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
            <button type="submit" disabled={submitting} className="btn-primary">
              {submitting ? 'Guardando…' : editing ? 'Guardar' : 'Crear'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}