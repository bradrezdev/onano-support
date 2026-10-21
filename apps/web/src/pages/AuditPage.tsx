import { useEffect, useState } from 'react'
import { ScrollText, RefreshCw } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import clsx from 'clsx'
import { api, ApiError } from '@/lib/api'

interface AuditEntry {
  id: string
  scope: 'ticket' | 'conversation'
  action: string
  actor_id: string
  actor_name: string | null
  actor_role: string
  target_id: string
  target_label: string | null
  from_value: unknown
  to_value: unknown
  created_at: string
}

const ACTION_LABELS: Record<string, string> = {
  created: 'creó',
  assigned: 'asignó',
  reassigned: 'reasignó',
  category_changed: 'cambió la categoría',
  theme_changed: 'cambió el proyecto',
  flow_changed: 'movió en el pipeline',
  status_changed: 'cambió el estado',
  closed: 'cerró',
  reopened: 'reabrió',
  trashed: 'envió a la papelera',
  restored: 'restauró',
}

const ROLE_STYLES: Record<string, string> = {
  supervisor: 'bg-violet-100 text-violet-700',
  soporte: 'bg-emerald-100 text-emerald-700',
  admin: 'bg-slate-200 text-slate-600',
}

export default function AuditPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<{ data: AuditEntry[] }>('/api/audit')
      setEntries(res.data)
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-slate-900">
            <ScrollText size={20} className="text-slate-500" />
            Auditoría
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Movimientos de Supervisores y Soporte. Solo lectura: nadie puede
            editar este registro, ni siquiera un Admin.
          </p>
        </div>
        <button type="button" onClick={load} className="btn-ghost" disabled={loading}>
          <RefreshCw size={14} className={clsx(loading && 'animate-spin')} />
          Actualizar
        </button>
      </header>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="card p-6 text-sm text-slate-500">Cargando…</div>
      ) : entries.length === 0 ? (
        <div className="card p-6 text-sm text-slate-500">
          Sin movimientos registrados todavía.
        </div>
      ) : (
        <ul className="card divide-y divide-slate-100">
          {entries.map((e) => (
            <li key={e.id} className="flex items-start justify-between gap-4 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span
                    className={clsx(
                      'rounded-full px-2 py-0.5 text-xs font-medium',
                      ROLE_STYLES[e.actor_role] ?? ROLE_STYLES.admin,
                    )}
                  >
                    {e.actor_role}
                  </span>
                  <span className="font-medium text-slate-900">
                    {e.actor_name ?? 'Sin nombre'}
                  </span>
                  <span className="text-slate-600">
                    {ACTION_LABELS[e.action] ?? e.action}
                  </span>
                  <span className="text-slate-500">
                    {e.target_label ?? e.target_id.slice(0, 8)}
                  </span>
                </div>
                {(e.from_value != null || e.to_value != null) && (
                  <div className="mt-1 font-mono text-xs text-slate-500">
                    {formatValue(e.from_value)} → {formatValue(e.to_value)}
                  </div>
                )}
              </div>
              <div className="shrink-0 text-xs text-slate-400">
                {formatDistanceToNow(new Date(e.created_at), { addSuffix: true })}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function formatValue(v: unknown): string {
  if (v == null) return '—'
  if (typeof v === 'string') return v
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
    if (entries.length === 0) return '—'
    return entries.map(([k, val]) => `${k}: ${shortId(val)}`).join(', ')
  }
  return String(v)
}

function shortId(v: unknown): string {
  if (typeof v !== 'string') return String(v)
  // UUIDs are unreadable in a log; show the first segment.
  return v.length > 24 ? `${v.slice(0, 8)}…` : v
}