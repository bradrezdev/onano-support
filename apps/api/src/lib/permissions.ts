/**
 * Permission catalogue + resolver (R2, recommendation 1).
 *
 * The rule: permissions are individual keys, roles are named bundles of them.
 * A role with no keys is an empty keyring — visible and obviously empty,
 * rather than failing later as a mysterious 403.
 *
 * Enforcement happens HERE, in the backend. Hiding a button is a "no entry"
 * sign with no door behind it; every route calls requirePermission, so a
 * crafted request is rejected regardless of what the SPA renders.
 *
 * The catalogue is duplicated from public.permissions in the DB on purpose:
 * the API needs the key list to validate input without a round trip, and the
 * DB is the source of truth for what each role actually holds.
 */

import type { AuthedUser } from './auth'

export type Permission =
  | 'admin.createUser'
  | 'admin.suspendUser'
  | 'admin.deleteUser'
  | 'admin.assignRole'
  | 'admin.manageRoles'
  | 'admin.viewAudit'
  | 'admin.viewAccounts'
  | 'category.create'
  | 'category.update'
  | 'category.delete'
  | 'subcategory.create'
  | 'subcategory.delete'
  | 'theme.create'
  | 'theme.delete'
  | 'flow.create'
  | 'flow.delete'
  | 'ticket.read'
  | 'ticket.create'
  | 'ticket.update'
  | 'ticket.assign'
  | 'ticket.close'
  | 'ticket.reopen'
  | 'ticket.moveFlow'
  | 'ticket.reply'
  | 'ticket.delete'
  | 'ticket.markMajor'
  | 'contact.read'
  | 'contact.create'
  | 'contact.update'
  | 'contact.delete'
  | 'conversation.read'
  | 'conversation.assign'
  | 'conversation.reassign'
  | 'conversation.escalate'

export interface PermissionMeta {
  key: Permission
  label: string
  group: string
}

export const PERMISSION_CATALOG: readonly PermissionMeta[] = [
  { key: 'admin.createUser', label: 'Crear usuarios', group: 'Cuentas' },
  { key: 'admin.suspendUser', label: 'Suspender usuarios', group: 'Cuentas' },
  { key: 'admin.deleteUser', label: 'Desactivar usuarios', group: 'Cuentas' },
  { key: 'admin.assignRole', label: 'Asignar roles', group: 'Cuentas' },
  { key: 'admin.manageRoles', label: 'Administrar roles', group: 'Cuentas' },
  { key: 'admin.viewAudit', label: 'Ver auditoría', group: 'Cuentas' },
  { key: 'admin.viewAccounts', label: 'Ver la lista de cuentas', group: 'Cuentas' },
  { key: 'category.create', label: 'Crear categorías', group: 'Categorías' },
  { key: 'category.update', label: 'Editar categorías', group: 'Categorías' },
  { key: 'category.delete', label: 'Eliminar categorías', group: 'Categorías' },
  { key: 'subcategory.create', label: 'Crear subcategorías', group: 'Categorías' },
  { key: 'subcategory.delete', label: 'Eliminar subcategorías', group: 'Categorías' },
  { key: 'theme.create', label: 'Crear proyectos', group: 'Proyectos' },
  { key: 'theme.delete', label: 'Eliminar proyectos', group: 'Proyectos' },
  { key: 'flow.create', label: 'Crear fases', group: 'Proyectos' },
  { key: 'flow.delete', label: 'Eliminar fases', group: 'Proyectos' },
  { key: 'ticket.read', label: 'Ver tickets', group: 'Tickets' },
  { key: 'ticket.create', label: 'Crear tickets', group: 'Tickets' },
  { key: 'ticket.update', label: 'Editar tickets', group: 'Tickets' },
  { key: 'ticket.assign', label: 'Asignar tickets', group: 'Tickets' },
  { key: 'ticket.close', label: 'Cerrar tickets', group: 'Tickets' },
  { key: 'ticket.reopen', label: 'Reabrir tickets', group: 'Tickets' },
  { key: 'ticket.moveFlow', label: 'Mover en el pipeline', group: 'Tickets' },
  { key: 'ticket.reply', label: 'Responder tickets', group: 'Tickets' },
  { key: 'ticket.delete', label: 'Eliminar tickets', group: 'Tickets' },
  { key: 'ticket.markMajor', label: 'Marcar ticket como incidencia mayor', group: 'Tickets' },
  { key: 'conversation.read', label: 'Leer conversaciones', group: 'Conversaciones' },
  { key: 'conversation.assign', label: 'Responder conversaciones', group: 'Conversaciones' },
  { key: 'conversation.reassign', label: 'Reasignar conversaciones', group: 'Conversaciones' },
  { key: 'conversation.escalate', label: 'Pedir apoyo', group: 'Conversaciones' },
  { key: 'contact.read', label: 'Ver clientes', group: 'Clientes' },
  { key: 'contact.create', label: 'Crear clientes', group: 'Clientes' },
  { key: 'contact.update', label: 'Editar clientes', group: 'Clientes' },
  { key: 'contact.delete', label: 'Eliminar clientes', group: 'Clientes' },
] as const

const CATALOG_KEYS = new Set<string>(PERMISSION_CATALOG.map((p) => p.key))

export function isKnownPermission(key: string): key is Permission {
  return CATALOG_KEYS.has(key)
}

export function can(user: AuthedUser | null | undefined, permission: Permission): boolean {
  if (!user) return false
  return user.permissions.includes(permission)
}

export function canAll(user: AuthedUser | null | undefined, permissions: Permission[]): boolean {
  return permissions.every((p) => can(user, p))
}