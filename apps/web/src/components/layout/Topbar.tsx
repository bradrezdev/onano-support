import { useNavigate } from 'react-router-dom'
import { ChevronDown, LogOut } from 'lucide-react'
import { useAuthStore } from '@/stores/auth'

export function Topbar() {
  const { profile, signOut, user } = useAuthStore()
  const navigate = useNavigate()

  if (!profile) {
    return (
      <header className="flex h-14 items-center justify-between border-b border-slate-200 bg-white px-6">
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <span>CRM</span>
        </div>
      </header>
    )
  }

  const name = profile.display_name?.trim() || user?.email || 'Usuario'
  const initial = name.trim().charAt(0).toUpperCase() || '?'

  return (
    <header className="flex h-14 items-center justify-between border-b border-slate-200 bg-white px-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        {/* breadcrumb slot — keep generic for now */}
        <span>CRM</span>
      </div>
      <div className="flex items-center gap-3">
        {/* The identity block is the way into your own profile. A plain div
            made the name look like a label; as a button it reads as "this is
            you, click to edit". */}
        <button
          type="button"
          onClick={() => navigate('/profile')}
          className="flex items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-slate-100"
          aria-label="Abrir mi perfil"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-100 text-sm font-medium text-brand-700">
            {initial}
          </span>
          <span className="leading-tight">
            <span className="block text-sm font-medium text-slate-900">{name}</span>
            <span className="block text-xs uppercase tracking-wide text-slate-500">
              {profile.role}
            </span>
          </span>
          <ChevronDown size={14} className="text-slate-400" />
        </button>

        <button
          type="button"
          onClick={() => signOut()}
          className="btn-ghost"
          aria-label="Cerrar sesión"
        >
          <LogOut size={16} />
          Salir
        </button>
      </div>
    </header>
  )
}