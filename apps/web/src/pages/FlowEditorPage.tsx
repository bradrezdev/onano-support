import { useEffect, useState } from 'react'
import { useNavigate, useParams, Link as RouterLink } from 'react-router-dom'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ArrowLeft, GripVertical, Plus, Trash2, Check } from 'lucide-react'
import clsx from 'clsx'
import { useAuthStore } from '@/stores/auth'
import { api, ApiError } from '@/lib/api'
import type { Flow, Theme, ThemeWithFlows } from '@/lib/themes'

export default function FlowEditorPage() {
  const { id = '' } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const profile = useAuthStore((s) => s.profile)
  const isAdmin = profile?.role === 'admin'
  const canReorder = profile?.role === 'admin' || profile?.role === 'supervisor'

  const [theme, setTheme] = useState<ThemeWithFlows | null>(null)
  const [flows, setFlows] = useState<Flow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [savingReorder, setSavingReorder] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Flow | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<{ data: (Theme & { flows: Flow[] })[] }>(
        '/api/themes',
      )
      const found = res.data.find((t) => t.id === id)
      if (!found) {
        setError('Tema no encontrado.')
        setTheme(null)
        setFlows([])
        return
      }
      setTheme(found)
      setFlows(found.flows)
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [id])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  )

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = flows.findIndex((f) => f.id === active.id)
    const newIndex = flows.findIndex((f) => f.id === over.id)
    if (oldIndex < 0 || newIndex < 0) return
    const next = arrayMove(flows, oldIndex, newIndex)
    const anchor = next[0]
    if (!anchor) return
    setFlows(next)
    setSavingReorder(true)
    try {
      await api.post(`/api/flows/${anchor.id}/reorder`, {
        theme_id: id,
        ordered_ids: next.map((f) => f.id),
      })
    } catch (err) {
      setError((err as ApiError).message)
      await load()
    } finally {
      setSavingReorder(false)
    }
  }

  async function handleDelete(flow: Flow) {
    if (!confirm(`¿Eliminar el flujo "${flow.name}"?`)) return
    try {
      await api.del(`/api/flows/${flow.id}`)
      await load()
    } catch (err) {
      alert((err as ApiError).message)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate('/themes')}
            className="btn-ghost p-2"
            aria-label="Volver a temas"
          >
            <ArrowLeft size={16} />
          </button>
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">
              {theme?.name ?? 'Cargando…'}
            </h1>
              <p className="mt-1 text-sm text-slate-500">
                Arrastra para reordenar los flujos.
                {savingReorder && ' Guardando…'}
              </p>
          </div>
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
            Nuevo flujo
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="card p-6 text-sm text-slate-500">Cargando…</div>
      ) : flows.length === 0 ? (
        <div className="card flex flex-col items-center gap-2 p-8 text-center text-sm text-slate-500">
          <p>Aún no hay flujos para este tema.</p>
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
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={flows.map((f) => f.id)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="card divide-y divide-slate-100">
              {flows.map((flow) => (
                <SortableFlowRow
                  key={flow.id}
                  flow={flow}
                  canDrag={canReorder}
                  isAdmin={isAdmin}
                  onEdit={() => {
                    setEditing(flow)
                    setFormOpen(true)
                  }}
                  onDelete={() => handleDelete(flow)}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}

      {theme && theme.flows.length === 0 && (
        <p className="text-center text-xs text-slate-400">
          <RouterLink to="/themes" className="underline">
            Volver al listado de temas
          </RouterLink>
        </p>
      )}

      {formOpen && (
        <FlowFormModal
          themeId={id}
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

function SortableFlowRow({
  flow,
  canDrag,
  isAdmin,
  onEdit,
  onDelete,
}: {
  flow: Flow
  canDrag: boolean
  isAdmin: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: flow.id, disabled: !canDrag })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  }

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={clsx(
        'flex items-center gap-3 px-4 py-3',
        isDragging && 'bg-slate-50',
      )}
    >
      {canDrag ? (
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="cursor-grab text-slate-400 hover:text-slate-700 active:cursor-grabbing"
          aria-label={`Reordenar ${flow.name}`}
        >
          <GripVertical size={16} />
        </button>
      ) : (
        <span className="inline-block w-4" aria-hidden />
      )}

      <div className="flex-1">
        <div className="flex items-center gap-2 font-medium text-slate-900">
          {flow.name}
          {flow.is_terminal && (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-700 ring-1 ring-emerald-200">
              <Check size={10} />
              Terminal
            </span>
          )}
        </div>
        {flow.description && (
          <div className="text-xs text-slate-500">{flow.description}</div>
        )}
      </div>

      {isAdmin && (
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="btn-ghost px-2 py-1 text-xs"
            onClick={onEdit}
          >
            Editar
          </button>
          <button
            type="button"
            className="btn-ghost p-1 text-slate-400 hover:text-red-600"
            onClick={onDelete}
            aria-label={`Eliminar ${flow.name}`}
          >
            <Trash2 size={14} />
          </button>
        </div>
      )}
    </li>
  )
}

function FlowFormModal({
  themeId,
  editing,
  onClose,
  onSaved,
}: {
  themeId: string
  editing: Flow | null
  onClose: () => void
  onSaved: () => void | Promise<void>
}) {
  const [name, setName] = useState(editing?.name ?? '')
  const [description, setDescription] = useState(editing?.description ?? '')
  const [isTerminal, setIsTerminal] = useState(editing?.is_terminal ?? false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      if (editing) {
        await api.patch(`/api/flows/${editing.id}`, {
          name: name.trim(),
          description: description.trim() || null,
          is_terminal: isTerminal,
        })
      } else {
        await api.post(`/api/themes/${themeId}/flows`, {
          name: name.trim(),
          description: description.trim() || null,
          is_terminal: isTerminal,
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
          {editing ? `Editar "${editing.name}"` : 'Nuevo flujo'}
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
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={isTerminal}
              onChange={(e) => setIsTerminal(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300"
            />
            <span>
              Es estado terminal{' '}
              <span className="text-xs text-slate-500">
                (los tickets no se mueven desde aquí)
              </span>
            </span>
          </label>
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