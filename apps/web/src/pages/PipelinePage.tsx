import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { GripVertical, Inbox } from 'lucide-react'
import clsx from 'clsx'
import { useAuthStore } from '@/stores/auth'
import { api, ApiError } from '@/lib/api'
import type { ThemeWithFlows } from '@/lib/themes'

interface Ticket {
  id: string
  name: string
  status: 'open' | 'in_progress' | 'closed'
  theme_id: string | null
  flow_id: string | null
  assigned_to: string | null
  contact_id: string
  updated_at: string
}

export default function PipelinePage() {
  const profile = useAuthStore((s) => s.profile)
  const canMove = profile?.role === 'admin' || profile?.role === 'supervisor' || profile?.role === 'soporte'

  const [themes, setThemes] = useState<ThemeWithFlows[]>([])
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTicket, setActiveTicket] = useState<Ticket | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [themesRes, ticketsRes] = await Promise.all([
        api.get<{ data: ThemeWithFlows[] }>('/api/themes'),
        api.get<{ data: Ticket[] }>('/api/tickets?status=open&limit=200'),
      ])
      setThemes(themesRes.data)
      setTickets(ticketsRes.data.filter((t) => t.theme_id !== null))
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  )

  function handleDragStart(event: DragStartEvent) {
    const ticket = tickets.find((t) => t.id === event.active.id)
    if (ticket) setActiveTicket(ticket)
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveTicket(null)
    const { active, over } = event
    if (!over) return
    const ticketId = String(active.id)
    const overId = String(over.id)
    if (overId === 'unassigned') {
      await moveTicketTo(ticketId, null)
      return
    }
    // overId = `${themeId}::${flowId}`
    const flowId = overId.split('::')[1] ?? null
    await moveTicketTo(ticketId, flowId)
  }

  async function moveTicketTo(ticketId: string, flowId: string | null) {
    const before = tickets.find((t) => t.id === ticketId)
    if (!before || before.flow_id === flowId) return
    setTickets((prev) =>
      prev.map((t) => (t.id === ticketId ? { ...t, flow_id: flowId } : t)),
    )
    try {
      await api.post(`/api/tickets/${ticketId}/flow`, { flow_id: flowId })
    } catch (err) {
      setError((err as ApiError).message)
      await load()
    }
  }

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">Pipeline</h1>
        <p className="mt-1 text-sm text-slate-500">
          {canMove
            ? 'Arrastra una tarjeta entre flujos para mover el ticket.'
            : 'Vista de solo lectura.'}
        </p>
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
          <Inbox size={32} className="text-slate-300" />
          <p>No hay proyectos. Crea al menos uno en Proyectos.</p>
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <div className="space-y-6 overflow-x-auto pb-4">
            {themes.map((theme) => (
              <ThemeRow
                key={theme.id}
                theme={theme}
                tickets={tickets.filter(
                  (t) => t.theme_id === theme.id || (!t.flow_id && t.theme_id === null),
                )}
                canMove={canMove}
              />
            ))}
          </div>
          <DragOverlay>
            {activeTicket ? (
              <div className="card rotate-1 cursor-grabbing p-3 text-sm shadow-lg">
                <div className="font-medium text-slate-900">
                  {activeTicket.name}
                </div>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  )
}

function ThemeRow({
  theme,
  tickets,
  canMove,
}: {
  theme: ThemeWithFlows
  tickets: Ticket[]
  canMove: boolean
}) {
  const themeTickets = tickets.filter((t) => t.theme_id === theme.id)

  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <span
          className="inline-block h-3 w-3 rounded-full border border-slate-200"
          style={{ backgroundColor: theme.color }}
          aria-hidden
        />
        <h2 className="text-lg font-medium text-slate-900">{theme.name}</h2>
        <span className="text-xs text-slate-400">
          {themeTickets.length} ticket{themeTickets.length === 1 ? '' : 's'}
        </span>
        <Link
          to={`/themes/${theme.id}`}
          className="text-xs text-indigo-600 hover:text-indigo-700"
        >
          Editar flujos
        </Link>
      </div>

      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${theme.flows.length}, minmax(220px, 1fr))` }}>
        {theme.flows.map((flow) => {
          const flowTickets = themeTickets.filter((t) => t.flow_id === flow.id)
          return (
            <FlowColumn
              key={flow.id}
              themeId={theme.id}
              flowId={flow.id}
              flowName={flow.name}
              isTerminal={flow.is_terminal}
              tickets={flowTickets}
              canMove={canMove}
            />
          )
        })}
        {theme.flows.length === 0 && (
          <div className="card p-4 text-sm text-slate-500">
            Este proyecto aún no tiene fases.
          </div>
        )}
      </div>
    </section>
  )
}

function FlowColumn({
  themeId,
  flowId,
  flowName,
  isTerminal,
  tickets,
  canMove,
}: {
  themeId: string
  flowId: string
  flowName: string
  isTerminal: boolean
  tickets: Ticket[]
  canMove: boolean
}) {
  const columnId = `${themeId}::${flowId}`
  const { setNodeRef, isOver } = useDroppable({ id: columnId })

  return (
    <div
      ref={setNodeRef}
      className={clsx(
        'card flex min-h-[200px] flex-col p-3 transition-colors',
        isOver && 'bg-indigo-50 ring-2 ring-indigo-300',
        isTerminal && 'bg-emerald-50/40',
      )}
    >
      <div className="mb-2 flex items-center justify-between text-xs">
        <span
          className={clsx(
            'font-semibold uppercase tracking-wide',
            isTerminal ? 'text-emerald-700' : 'text-slate-600',
          )}
        >
          {flowName}
          {isTerminal && ' ✓'}
        </span>
        <span className="text-slate-400">{tickets.length}</span>
      </div>

      <div className="flex flex-1 flex-col gap-2">
        {tickets.map((ticket) => (
          <TicketCard key={ticket.id} ticket={ticket} canDrag={canMove} />
        ))}
        {tickets.length === 0 && (
          <div className="flex flex-1 items-center justify-center rounded border border-dashed border-slate-200 p-3 text-xs text-slate-400">
            Vacío
          </div>
        )}
      </div>
    </div>
  )
}

function TicketCard({
  ticket,
  canDrag,
}: {
  ticket: Ticket
  canDrag: boolean
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    isDragging,
    transform,
  } = useDraggable({
    id: ticket.id,
    disabled: !canDrag,
  })

  const style = transform
    ? {
        transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
      }
    : undefined

  return (
    <Link
      to={`/tickets/${ticket.id}`}
      ref={setNodeRef}
      style={style}
      className={clsx(
        'card flex items-center gap-2 p-2 text-sm hover:shadow-md',
        isDragging && 'opacity-30',
      )}
    >
      {canDrag && (
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="cursor-grab text-slate-400 hover:text-slate-700 active:cursor-grabbing"
          aria-label={`Mover ${ticket.name}`}
          onClick={(e) => e.preventDefault()}
        >
          <GripVertical size={14} />
        </button>
      )}
      <span className="flex-1 truncate font-medium text-slate-900">
        {ticket.name}
      </span>
    </Link>
  )
}