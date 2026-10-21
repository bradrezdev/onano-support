import { NavLink } from 'react-router-dom'
import {
  Inbox,
  Users,
  Ticket,
  Layers,
  FolderTree,
  FolderKanban,
  ShieldCheck,
  Palette,
  ScrollText,
  Trash2,
  KeyRound,
  LayoutDashboard,
} from 'lucide-react'
import { useAuthStore } from '@/stores/auth'
import { canWith } from '@/lib/permissions'
import clsx from 'clsx'

const items = [
  { to: '/', label: 'Mi bandeja', icon: LayoutDashboard },
  { to: '/inbox', label: 'Conversaciones', icon: Inbox },
  // "Clientes", not "Contactos": the records here are the people the company
  // serves, not a directory of contacts to call. They have no login.
  { to: '/contacts', label: 'Clientes', icon: Users },
  { to: '/tickets', label: 'Tickets', icon: Ticket },
  { to: '/pipeline', label: 'Pipeline', icon: Layers },
]

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  clsx(
    'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
    isActive
      ? 'bg-brand-50 text-brand-700'
      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
  )

export function Sidebar() {
  const { profile } = useAuthStore()

  // Permission-driven, not role-driven (R2): a custom role granted
  // admin.viewAudit sees the audit page even though it is not "admin".
  const showUsers = canWith(profile, 'admin.viewAccounts')
  const showCategories = canWith(profile, 'category.create')
  const showThemes = canWith(profile, 'theme.create')
  const showAudit = canWith(profile, 'admin.viewAudit')
  const showTrash = canWith(profile, 'ticket.delete')

  return (
    <aside className="flex w-56 flex-col border-r border-slate-200 bg-white">
      <div className="flex h-14 items-center gap-2 border-b border-slate-200 px-4">
        <span className="text-lg font-semibold tracking-tight text-brand-700">
          WhatsApp CRM
        </span>
      </div>
      <nav className="flex-1 space-y-1 px-2 py-3">
        {items.map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to} end={to === '/'} className={navLinkClass}>
            <Icon size={16} />
            {label}
          </NavLink>
        ))}

        {showUsers && (
          <NavLink to="/users" className={navLinkClass}>
            <ShieldCheck size={16} />
            Usuarios
          </NavLink>
        )}

        {showUsers && canWith(profile, 'admin.manageRoles') && (
          <>
            <NavLink to="/roles" className={navLinkClass} end>
              <KeyRound size={16} />
              Roles
            </NavLink>
            <NavLink to="/roles/colors" className={navLinkClass}>
              <Palette size={16} />
              Colores de rol
            </NavLink>
          </>
        )}

        {showCategories && (
          <NavLink to="/categories" className={navLinkClass}>
            <FolderTree size={16} />
            Categorías
          </NavLink>
        )}
        {showThemes && (
          <NavLink to="/themes" className={navLinkClass}>
            {/* FolderKanban, not Palette: a project is a body of work that moves
                through phases. The paint palette belonged to the old "Tema"
                name and meant nothing here. */}
            <FolderKanban size={16} />
            Proyectos
          </NavLink>
        )}
        {showAudit && (
          <NavLink to="/audit" className={navLinkClass}>
            <ScrollText size={16} />
            Auditoría
          </NavLink>
        )}
        {showTrash && (
          <NavLink to="/tickets/trash" end className={navLinkClass}>
            <Trash2 size={16} />
            Papelera
          </NavLink>
        )}
      </nav>
    </aside>
  )
}