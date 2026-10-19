/**
 * Role types and permission matrix shared with the backend (apps/api).
 * Kept in sync manually until packages/shared is added.
 */

export type Role = 'admin' | 'supervisor' | 'soporte'

export type Action =
  | 'admin.createUser'
  | 'admin.suspendUser'
  | 'admin.deleteUser'
  | 'admin.assignRole'
  | 'category.create'
  | 'category.update'
  | 'category.delete'
  | 'subcategory.create'
  | 'subcategory.delete'
  | 'theme.create'
  | 'theme.delete'
  | 'flow.create'
  | 'flow.delete'
  | 'ticket.create'
  | 'ticket.assign'
  | 'ticket.close'
  | 'ticket.reopen'
  | 'ticket.moveFlow'
  | 'ticket.reply'
  | 'conversation.read'
  | 'conversation.assign'
  | 'conversation.reassign'

const matrix: Record<Role, ReadonlySet<Action>> = {
  admin: new Set<Action>([
    'admin.createUser',
    'admin.suspendUser',
    'admin.deleteUser',
    'admin.assignRole',
    'category.create',
    'category.update',
    'category.delete',
    'subcategory.create',
    'subcategory.delete',
    'theme.create',
    'theme.delete',
    'flow.create',
    'flow.delete',
    'ticket.create',
    'ticket.assign',
    'ticket.close',
    'ticket.reopen',
    'ticket.moveFlow',
    'ticket.reply',
    'conversation.read',
    'conversation.assign',
    'conversation.reassign',
  ]),
  supervisor: new Set<Action>([
    'category.create',
    'category.update',
    'subcategory.create',
    'flow.create',
    'ticket.create',
    'ticket.assign',
    'ticket.moveFlow',
    'ticket.reply',
    'conversation.read',
    'conversation.assign',
    'conversation.reassign',
  ]),
  soporte: new Set<Action>([
    'ticket.create',
    'ticket.reply',
    'conversation.read',
    'conversation.assign',
  ]),
}

export function can(role: Role | undefined | null, action: Action): boolean {
  if (!role) return false
  return matrix[role].has(action)
}

export function isAdmin(role: Role | undefined | null): boolean {
  return role === 'admin'
}

export function isSupervisorOrAbove(role: Role | undefined | null): boolean {
  return role === 'admin' || role === 'supervisor'
}