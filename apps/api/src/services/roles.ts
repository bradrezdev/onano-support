/**
 * Custom roles service (R2, recommendation 1).
 *
 * A role is a name, a color and a bundle of permission keys. That is the whole
 * model — no role hierarchy, no inheritance, no rules engine. A role that
 * grants nothing is a valid, visibly empty keyring rather than an error.
 *
 * System roles (admin, supervisor, soporte) ship with the app and cannot be
 * deleted or re-keyed. The DB enforces that too, via triggers — this service
 * only refuses early so the caller gets a useful message instead of a
 * Postgres error string.
 */

import { createSupabaseAdminClient } from '@/lib/supabase/admin'
import { isKnownPermission, type Permission } from '@/lib/permissions'

export interface Role {
  id: string
  key: string
  name: string
  description: string | null
  color: string
  is_system: boolean
  created_at: string
  permissions?: Permission[]
  user_count?: number
}

export class RoleValidationError extends Error {
  status: number
  code: string
  constructor(code: string, message: string, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

const KEY_PATTERN = /^[a-z][a-z0-9_]{1,30}$/
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

/**
 * The three slugs that `role_color_settings` can hold. It is keyed by these
 * slugs, so a custom role's color lives only in `roles` — see updateRole.
 */
const SHIPPED_ROLE_KEYS = ['admin', 'supervisor', 'soporte'] as const
type ShippedRoleKey = (typeof SHIPPED_ROLE_KEYS)[number]

function isShippedRoleKey(key: string): key is ShippedRoleKey {
  return (SHIPPED_ROLE_KEYS as readonly string[]).includes(key)
}

export async function listRoles(): Promise<Role[]> {
  const admin = createSupabaseAdminClient()

  const { data: roles, error } = await admin
    .from('roles')
    .select('id, key, name, description, color, is_system, created_at')
    .order('is_system', { ascending: false })
    .order('name', { ascending: true })
  if (error) throw error

  const { data: perms, error: pErr } = await admin
    .from('role_permissions')
    .select('role_id, permission_key')
  if (pErr) throw pErr

  // One count query beats N round trips for the "who uses this role" column.
  const { data: profiles } = await admin.from('profiles').select('role_key')

  const counts = new Map<string, number>()
  for (const p of (profiles ?? []) as { role_key: string | null }[]) {
    if (!p.role_key) continue
    counts.set(p.role_key, (counts.get(p.role_key) ?? 0) + 1)
  }

  const byRole = new Map<string, Permission[]>()
  for (const row of (perms ?? []) as { role_id: string; permission_key: string }[]) {
    const list = byRole.get(row.role_id) ?? []
    if (isKnownPermission(row.permission_key)) list.push(row.permission_key)
    byRole.set(row.role_id, list)
  }

  return ((roles ?? []) as Role[]).map((r) => ({
    ...r,
    permissions: (byRole.get(r.id) ?? []).sort(),
    user_count: counts.get(r.key) ?? 0,
  }))
}

export async function createRole(input: {
  key: string
  name: string
  description?: string | null
  color: string
  permissions: Permission[]
}, actorId: string): Promise<Role> {
  const admin = createSupabaseAdminClient()

  if (!KEY_PATTERN.test(input.key)) {
    throw new RoleValidationError(
      'invalid_key',
      'La clave debe empezar por letra minúscula y usar solo letras, números y guion bajo',
    )
  }
  if (!input.name.trim()) {
    throw new RoleValidationError('invalid_name', 'El nombre no puede estar vacío')
  }
  if (!HEX_COLOR.test(input.color)) {
    throw new RoleValidationError('invalid_color', 'El color debe ser un hex de 6 dígitos (#rrggbb)')
  }

  const { data: existing } = await admin
    .from('roles')
    .select('id, is_system')
    .eq('key', input.key)
    .maybeSingle<{ id: string; is_system: boolean }>()
  if (existing) {
    throw new RoleValidationError('duplicate_key', `Ya existe un rol con la clave "${input.key}"`, 409)
  }

  const { data: role, error } = await admin
    .from('roles')
    .insert({
      key: input.key,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      color: input.color,
      is_system: false,
      created_by: actorId,
    })
    .select('id, key, name, description, color, is_system, created_at')
    .single<Role>()
  if (error) throw error

  await replacePermissions(role.id, input.permissions, actorId)

  return { ...role, permissions: [...input.permissions].sort(), user_count: 0 }
}

export async function updateRole(
  id: string,
  patch: { name?: string; description?: string | null; color?: string; permissions?: Permission[] },
  actorId: string,
): Promise<Role> {
  const admin = createSupabaseAdminClient()
  const before = await findRoleOrThrow(id)

  const update: Record<string, unknown> = {}
  if (patch.name !== undefined) {
    if (!patch.name.trim()) {
      throw new RoleValidationError('invalid_name', 'El nombre no puede estar vacío')
    }
    update.name = patch.name.trim()
  }
  if (patch.description !== undefined) {
    update.description = patch.description?.trim() || null
  }
  if (patch.color !== undefined) {
    if (!HEX_COLOR.test(patch.color)) {
      throw new RoleValidationError('invalid_color', 'El color debe ser un hex de 6 dígitos (#rrggbb)')
    }
    update.color = patch.color
  }

  if (Object.keys(update).length > 0) {
    const { error } = await admin.from('roles').update(update).eq('id', id)
    if (error) throw error
  }

  // Keep the color in step across both places it is stored (see the note in
  // upsertRoleColor). A custom role has no `role_color_settings` row — that
  // table only covers the three shipped slugs — so only those sync, and the
  // admin UI says so rather than implying a color applied that did not.
  if (patch.color !== undefined && patch.color !== before.color) {
    if (isShippedRoleKey(before.key)) {
      // try/catch covers the synchronous half of the builder chain as well —
      // a promise-level catch would miss a throw that happens before the await.
      try {
        const { error: colorErr } = await admin
          .from('role_color_settings')
          .upsert(
            {
              role: before.key,
              base_color: patch.color,
              updated_by: actorId,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'role' },
          )
        if (colorErr) {
          console.warn('[roles] role_color_settings not synced', colorErr.message)
        }
      } catch (mirrorErr) {
        console.warn(
          '[roles] role_color_settings mirror threw',
          mirrorErr instanceof Error ? mirrorErr.message : mirrorErr,
        )
      }
    }
  }

  if (patch.permissions !== undefined) {
    await replacePermissions(id, patch.permissions, actorId)
  }

  const after = await findRoleOrThrow(id)
  return { ...after, permissions: [...(patch.permissions ?? before.permissions ?? [])].sort() }
}

/**
 * Delete a custom role. Refuses system roles and refuses roles that still
 * have members — otherwise those profiles would be left holding a slug with
 * nothing behind it.
 */
export async function deleteRole(id: string): Promise<{ deleted: true }> {
  const admin = createSupabaseAdminClient()
  const role = await findRoleOrThrow(id)

  if (role.is_system) {
    throw new RoleValidationError('system_role', 'Los roles del sistema no se pueden eliminar', 409)
  }

  const { data: members } = await admin
    .from('profiles')
    .select('id')
    .eq('role_key', role.key)
    .limit(1)
  if ((members ?? []).length > 0) {
    throw new RoleValidationError(
      'role_in_use',
      'El rol tiene usuarios asignados. Reasígnalos antes de eliminarlo',
      409,
    )
  }

  const { error } = await admin.from('roles').delete().eq('id', id)
  if (error) throw error
  return { deleted: true }
}

async function replacePermissions(
  roleId: string,
  permissions: Permission[],
  actorId: string,
): Promise<void> {
  const admin = createSupabaseAdminClient()
  const known = permissions.filter((p) => isKnownPermission(p))
  if (known.length !== permissions.length) {
    throw new RoleValidationError(
      'unknown_permission',
      'Uno o más permisos no existen en el catálogo',
    )
  }

  // The replacement and its audit entry land in the SAME transaction
  // (`admin_replace_role_permissions`). Delete + insert as two calls could
  // leave a role with no permissions and no trail of who emptied it.
  const { error } = await admin.rpc('admin_replace_role_permissions', {
    p_role_id: roleId,
    p_permission_keys: known,
    p_actor: actorId,
  })
  if (error) throw error
}

export async function findRoleOrThrow(id: string): Promise<Role> {
  const admin = createSupabaseAdminClient()
  const { data, error } = await admin
    .from('roles')
    .select('id, key, name, description, color, is_system, created_at')
    .eq('id', id)
    .maybeSingle<Role>()
  if (error) throw error
  if (!data) throw new RoleValidationError('not_found', 'Rol no encontrado', 404)
  return data
}