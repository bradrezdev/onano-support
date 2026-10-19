import { useEffect, useState } from 'react'
import { useAuthStore } from '@/stores/auth'
import { api, ApiError } from '@/lib/api'
import { ChevronRight, Plus, Folder, FolderOpen, Trash2 } from 'lucide-react'
import clsx from 'clsx'

interface Category {
  id: string
  parent_id: string | null
  name: string
  description: string | null
  children: Category[]
}

export default function CategoriesPage() {
  const profile = useAuthStore((s) => s.profile)
  const isAdmin = profile?.role === 'admin'

  const [tree, setTree] = useState<Category[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [formParent, setFormParent] = useState<Category | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<{ data: Category[] }>('/api/categories')
      setTree(res.data)
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function handleDelete(cat: Category) {
    if (cat.children.length > 0) {
      alert(`"${cat.name}" tiene ${cat.children.length} sub-categoría(s). Elimínalas antes.`)
      return
    }
    if (!confirm(`¿Eliminar la categoría "${cat.name}"?`)) return
    try {
      await api.del(`/api/categories/${cat.id}`)
      await load()
    } catch (err) {
      alert((err as ApiError).message)
    }
  }

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Categorías</h1>
          <p className="mt-1 text-sm text-slate-500">
            Taxonomía usada para clasificar tickets. Dos niveles: categoría + sub-categoría.
          </p>
        </div>
        {isAdmin && (
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              setFormParent(null)
              setFormOpen(true)
            }}
          >
            <Plus size={16} />
            Nueva categoría
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
      ) : tree.length === 0 ? (
        <div className="card flex flex-col items-center gap-2 p-8 text-center text-sm text-slate-500">
          <Folder size={32} className="text-slate-300" />
          <p>Aún no hay categorías.</p>
          {isAdmin && (
            <button
              type="button"
              className="btn-primary mt-2"
              onClick={() => {
                setFormParent(null)
                setFormOpen(true)
              }}
            >
              Crear la primera
            </button>
          )}
        </div>
      ) : (
        <div className="card divide-y divide-slate-100">
          {tree.map((cat) => (
            <CategoryRow
              key={cat.id}
              cat={cat}
              depth={0}
              isAdmin={isAdmin}
              onAddSub={(c) => {
                setFormParent(c)
                setFormOpen(true)
              }}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      {formOpen && (
        <CategoryFormModal
          parent={formParent}
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

function CategoryRow({
  cat,
  depth,
  isAdmin,
  onAddSub,
  onDelete,
}: {
  cat: Category
  depth: number
  isAdmin: boolean
  onAddSub: (c: Category) => void
  onDelete: (c: Category) => void
}) {
  const [open, setOpen] = useState(depth === 0)
  const hasChildren = cat.children.length > 0

  return (
    <div>
      <div
        className={clsx(
          'flex items-center gap-2 px-4 py-3 hover:bg-slate-50',
        )}
        style={{ paddingLeft: 16 + depth * 24 }}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-slate-400 hover:text-slate-700"
          aria-label={open ? 'Colapsar' : 'Expandir'}
          disabled={!hasChildren}
        >
          {hasChildren ? (
            <ChevronRight
              size={16}
              className={clsx('transition-transform', open && 'rotate-90')}
            />
          ) : (
            <span className="inline-block w-4" />
          )}
        </button>
        {open && hasChildren ? (
          <FolderOpen size={16} className="text-amber-500" />
        ) : (
          <Folder size={16} className="text-amber-500" />
        )}
        <div className="flex-1">
          <div className="font-medium text-slate-900">{cat.name}</div>
          {cat.description && (
            <div className="text-xs text-slate-500">{cat.description}</div>
          )}
        </div>
        {isAdmin && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="btn-ghost px-2 py-1 text-xs"
              onClick={() => onAddSub(cat)}
              title="Añadir sub-categoría"
            >
              <Plus size={14} />
              Sub
            </button>
            <button
              type="button"
              className="btn-ghost px-2 py-1 text-xs text-slate-400 hover:text-red-600"
              onClick={() => onDelete(cat)}
              title="Eliminar"
            >
              <Trash2 size={14} />
            </button>
          </div>
        )}
      </div>
      {open && hasChildren && (
        <div>
          {cat.children.map((sub) => (
            <CategoryRow
              key={sub.id}
              cat={sub}
              depth={depth + 1}
              isAdmin={isAdmin}
              onAddSub={onAddSub}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function CategoryFormModal({
  parent,
  onClose,
  onSaved,
}: {
  parent: Category | null
  onClose: () => void
  onSaved: () => void | Promise<void>
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      await api.post('/api/categories', {
        name: name.trim(),
        description: description.trim() || null,
        parent_id: parent?.id ?? null,
      })
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
          {parent ? `Nueva sub-categoría de "${parent.name}"` : 'Nueva categoría'}
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
              {submitting ? 'Guardando…' : 'Crear'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}