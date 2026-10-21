/**
 * Role types and permission checks shared with the backend (apps/api).
 *
 * Since R2 the server is authoritative: it resolves the keyring and sends it
 * in /api/me. This module keeps two things:
 *
 *   1. `canPermission(permissions, action)` — the real check, reading the
 *      keyring the server sent. This is what components should use.
 *   2. `can(role, action)` — a fallback for the three shipped roles, used
 *      only before /api/me resolves or in isolated tests. It CANNOT know
 *      about custom roles, so never build a custom-role feature on it.
 *
 * Hiding a button is a sign with no door. Every one of these is a UI
 * convenience; the actual rejection happens in the route handler.
 */

export type Role = 'admin' | 'supervisor' | 'soporte'

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
  | 'conversation.read'
  | 'conversation.assign'
  | 'conversation.reassign'
  | 'conversation.escalate'

/** Kept as an alias so existing call sites keep compiling. */
export type Action = Permission

/** Shipped roles, with the keyring the migration seeds for each. */
const SHIPPED_KEYRINGS: Record<Role, ReadonlySet<Permission>> = {
  admin: new Set<Permission>([
    'admin.createUser',
    'admin.suspendUser',
    'admin.deleteUser',
    'admin.assignRole',
    'admin.manageRoles',
    'admin.viewAudit',
    'admin.viewAccounts',
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
    'ticket.delete',
    'ticket.markMajor',
    'conversation.read',
    'conversation.assign',
    'conversation.reassign',
    'conversation.escalate',
  ]),
  supervisor: new Set<Permission>([
    'category.create',
    'category.update',
    'subcategory.create',
    'theme.create',
    'flow.create',
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
  soporte: new Set<Permission>([
    'ticket.create',
    'ticket.reply',
    'conversation.read',
    'conversation.assign',
    'conversation.escalate',
  ]),
}

/**
 * The real check. Reads the keyring the server resolved for this user.
 */
export function canPermission(
  permissions: readonly Permission[] | undefined | null,
  action: Permission,
): boolean {
  if (!permissions) return false
  return permissions.includes(action)
}

/**
 * Fallback for the three shipped roles only. Blind to custom roles — if you
 * are building something that a custom role must be able to use, call
 * canPermission instead.
 */
export function can(role: Role | undefined | null, action: Permission): boolean {
  if (!role) return false
  return SHIPPED_KEYRINGS[role].has(action)
}

/**
 * Picks the right source: the server keyring when it has arrived, the
 * shipped fallback only while it has not. This is what components use.
 *
 * The distinction is "has the keyring arrived", NOT "is it non-empty". An
 * empty array is a resolved answer meaning "this role holds nothing" — the
 * blank-badge case. Falling back on emptiness would hand a freshly created
 * empty role every power its legacy `role` column implies, which is the
 * opposite of what an empty keyring means.
 */
export function canWith(
  profile: { role?: Role | null; permissions?: readonly Permission[] | null } | null | undefined,
  action: Permission,
): boolean {
  if (!profile) return false
  if (profile.permissions != null) {
    return canPermission(profile.permissions, action)
  }
  return can(profile.role, action)
}

export function isAdmin(role: Role | undefined | null): boolean {
  return role === 'admin'
}

export function isSupervisorOrAbove(role: Role | undefined | null): boolean {
  return role === 'admin' || role === 'supervisor'
}