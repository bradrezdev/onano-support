import { LogOut } from 'lucide-react'
import { useAuthStore } from '@/stores/auth'

export function Topbar() {
  const { profile, signOut, user } = useAuthStore()

  return (
    <header className="flex h-14 items-center justify-between border-b border-slate-200 bg-white px-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        {/* breadcrumb slot — keep generic for now */}
        <span>CRM</span>
      </div>
      <div className="flex items-center gap-3">
        {profile && (
          <div className="text-right leading-tight">
            <div className="text-sm font-medium text-slate-900">
              {profile.display_name ?? user?.email ?? 'Usuario'}
            </div>
            <div className="text-xs uppercase tracking-wide text-slate-500">
              {profile.role}
            </div>
          </div>
        )}
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