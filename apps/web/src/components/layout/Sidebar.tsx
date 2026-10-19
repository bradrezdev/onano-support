import { NavLink } from 'react-router-dom'
import {
  Inbox,
  Users,
  Ticket,
  Layers,
  FolderTree,
  Settings,
  ShieldCheck,
  Palette,
} from 'lucide-react'
import { useAuthStore } from '@/stores/auth'
import { isAdmin, isSupervisorOrAbove } from '@/lib/permissions'
import clsx from 'clsx'

const items = [
  { to: '/inbox', label: 'Bandeja', icon: Inbox },
  { to: '/contacts', label: 'Contactos', icon: Users },
  { to: '/tickets', label: 'Tickets', icon: Ticket },
  { to: '/pipeline', label: 'Pipeline', icon: Layers },
]

export function Sidebar() {
  const { profile } = useAuthStore()
  const role = profile?.role

  return (
    <aside className="flex w-56 flex-col border-r border-slate-200 bg-white">
      <div className="flex h-14 items-center gap-2 border-b border-slate-200 px-4">
        <span className="text-lg font-semibold tracking-tight text-brand-700">
          WhatsApp CRM
        </span>
      </div>
      <nav className="flex-1 space-y-1 px-2 py-3">
        {items.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              clsx(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-brand-50 text-brand-700'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
              )
            }
          >
            <Icon size={16} />
            {label}
          </NavLink>
        ))}

        {isSupervisorOrAbove(role) && (
          <NavLink
            to="/users"
            className={({ isActive }) =>
              clsx(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-brand-50 text-brand-700'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
              )
            }
          >
            <ShieldCheck size={16} />
            Usuarios
          </NavLink>
        )}

        {isAdmin(role) && (
          <>
            <NavLink
              to="/categories"
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-brand-50 text-brand-700'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
                )
              }
            >
              <FolderTree size={16} />
              Categorías
            </NavLink>
            <NavLink
              to="/admin/users"
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-brand-50 text-brand-700'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
                )
              }
            >
              <ShieldCheck size={16} />
              Admin
            </NavLink>
            <NavLink
              to="/themes"
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-brand-50 text-brand-700'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
                )
              }
            >
              <Palette size={16} />
              Temas
            </NavLink>
          </>
        )}
      </nav>
      <NavLink
        to="/settings"
        className={({ isActive }) =>
          clsx(
            'flex items-center gap-3 border-t border-slate-200 px-4 py-3 text-sm font-medium transition-colors',
            isActive
              ? 'bg-brand-50 text-brand-700'
              : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
          )
        }
      >
        <Settings size={16} />
        Configuración
      </NavLink>
    </aside>
  )
}