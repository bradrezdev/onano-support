import { createSupabaseAdminClient } from '@/lib/supabase/admin'

export interface UserWithProfile {
  id: string
  email: string | null
  display_name: string | null
  /** Self-set contact number (profile page). Display only. */
  phone: string | null
  /** Legacy column, still constrained to the three shipped slugs. */
  role: 'admin' | 'supervisor' | 'soporte'
  /** Source of truth: slug of the role in public.roles (R2). */
  role_key: string
  avatar_url: string | null
  suspended_at: string | null
  deleted_at: string | null
  created_at: string | null
  last_sign_in_at: string | null
}

export interface UserTicketCounts {
  open_count: number
  closed_count: number
  total_count: number
}

export class UserValidationError extends Error {
  status: number
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.status = 400
  }
}

export async function listUsers(): Promise<UserWithProfile[]> {
  const admin = createSupabaseAdminClient()
  const [{ data: profileRows, error: pErr }, { data: userList, error: uErr }] =
    await Promise.all([
      admin
        .from('profiles')
        .select('id, role, role_key, display_name, phone, avatar_url, suspended_at, deleted_at')
        .order('display_name', { ascending: true }),
      admin.auth.admin.listUsers({ perPage: 1000 }),
    ])
  if (pErr) throw pErr
  if (uErr) throw uErr

  const profileById = new Map(
    ((profileRows ?? []) as { id: string; role: string | null; role_key: string | null; display_name: string | null; phone: string | null; avatar_url: string | null; suspended_at: string | null; deleted_at: string | null }[]).map(
      (p) => [p.id, p],
    ),
  )
  return userList.users.map((u) => {
    const p = profileById.get(u.id)
    const legacyRole = (p?.role as UserWithProfile['role']) ?? 'soporte'
    return {
      id: u.id,
      email: u.email ?? null,
      display_name: p?.display_name ?? null,
      phone: p?.phone ?? null,
      role: legacyRole,
      role_key: p?.role_key ?? legacyRole,
      avatar_url: p?.avatar_url ?? null,
      suspended_at: p?.suspended_at ?? null,
      deleted_at: p?.deleted_at ?? null,
      created_at: u.created_at ?? null,
      last_sign_in_at: u.last_sign_in_at ?? null,
    }
  })
}

export async function findUserOrThrow(id: string): Promise<UserWithProfile> {
  const admin = createSupabaseAdminClient()
  const { data: profile, error: pErr } = await admin
    .from('profiles')
    .select('id, role, role_key, display_name, phone, avatar_url, suspended_at, deleted_at')
    .eq('id', id)
    .maybeSingle<{
      id: string
      role: UserWithProfile['role']
      role_key: string | null
      display_name: string | null
      phone: string | null
      avatar_url: string | null
      suspended_at: string | null
      deleted_at: string | null
    }>()
  if (pErr) throw pErr

  const { data, error } = await admin.auth.admin.getUserById(id)
  if (error) throw error
  const legacyRole = profile?.role ?? 'soporte'
  return {
    id: data.user.id,
    email: data.user.email ?? null,
    display_name: profile?.display_name ?? null,
    phone: profile?.phone ?? null,
    role: legacyRole,
    role_key: profile?.role_key ?? legacyRole,
    avatar_url: profile?.avatar_url ?? null,
    suspended_at: profile?.suspended_at ?? null,
    deleted_at: profile?.deleted_at ?? null,
    created_at: data.user.created_at ?? null,
    last_sign_in_at: data.user.last_sign_in_at ?? null,
  }
}

export interface AssignableAgent {
  id: string
  display_name: string | null
  role: UserWithProfile['role']
  role_key: string
}

/**
 * Minimal agent list for assignee pickers (ticket assignee, conversation
 * owner). Only accounts that can actually take work: not suspended, not
 * deleted. Deliberately omits email and activity metadata so a non-admin can
 * populate a dropdown without seeing account details (R1).
 */
export async function listAssignableAgents(): Promise<AssignableAgent[]> {
  const admin = createSupabaseAdminClient()
  const { data, error } = await admin
    .from('profiles')
    .select('id, display_name, role, role_key')
    .is('suspended_at', null)
    .is('deleted_at', null)
    .order('display_name', { ascending: true })

  if (error) throw error
  return ((data ?? []) as AssignableAgent[]).map((a) => ({
    id: a.id,
    display_name: a.display_name,
    role: a.role,
    role_key: a.role_key ?? a.role,
  }))
}

export async function searchUsers(query: string): Promise<UserWithProfile[]> {
  if (!query.trim()) return []
  const admin = createSupabaseAdminClient()
  const all = await listUsers()
  const needle = query.toLowerCase()
  return all.filter((u) => {
    if (u.deleted_at) return false
    const e = u.email?.toLowerCase() ?? ''
    const d = u.display_name?.toLowerCase() ?? ''
    return e.includes(needle) || d.includes(needle)
  })
}

export async function getUserTicketCounts(id: string): Promise<UserTicketCounts> {
  const admin = createSupabaseAdminClient()
  const { data, error } = await admin
    .from('tickets')
    .select('status')
    .eq('assigned_to', id)
  if (error) throw error
  const rows = (data ?? []) as { status: 'open' | 'in_progress' | 'closed' }[]
  const open = rows.filter((r) => r.status !== 'closed').length
  const closed = rows.filter((r) => r.status === 'closed').length
  return {
    open_count: open,
    closed_count: closed,
    total_count: rows.length,
  }
}

export interface UserUpdateInput {
  /** Slug of the target role. Accepts shipped keys and custom ones. */
  role?: string
  suspend?: boolean
  display_name?: string
}

/**
 * Admin-only mutations on a profile. Guard rails:
 *   - cannot suspend yourself (would lock the workspace)
 *   - cannot move yourself off `admin` (would lock the workspace)
 *   - cannot change the role of a deleted user
 *   - the target role must exist
 *
 * Writing `role_key` is the source of truth (R2). The legacy `role` column is
 * kept in sync only for the three shipped slugs, because it still has a check
 * constraint in the schema and role_color_settings keys off it.
 *
 * Suspended/deleted users are rejected at the auth boundary (getCurrentUser)
 * on the next API call.
 */
export async function updateUser(
  id: string,
  patch: UserUpdateInput,
  actorId: string,
): Promise<UserWithProfile> {
  if (id === actorId && patch.suspend === true) {
    throw new UserValidationError('self_suspend', 'No puedes suspenderte a ti mismo')
  }
  if (id === actorId && patch.role && patch.role !== 'admin') {
    throw new UserValidationError('self_demote', 'No puedes degradarte a ti mismo')
  }

  const admin = createSupabaseAdminClient()
  const before = await findUserOrThrow(id)
  if (before.deleted_at) {
    throw new UserValidationError('user_deleted', 'User is deleted')
  }

  // What changes, resolved BEFORE the write so the write is a single call.
  const change: {
    role_key?: string
    legacy_role?: string
    suspend?: boolean
    display_name?: string
  } = {}

  if (patch.role !== undefined && patch.role !== before.role_key) {
    const { data: role } = await admin
      .from('roles')
      .select('key, is_system')
      .eq('key', patch.role)
      .maybeSingle<{ key: string; is_system: boolean }>()
    if (!role) {
      throw new UserValidationError('role_not_found', `El rol "${patch.role}" no existe`)
    }
    change.role_key = role.key
    // Only the shipped slugs may be mirrored into the legacy constrained
    // column; a custom role has no value that would pass the check.
    if (role.is_system && (role.key === 'admin' || role.key === 'supervisor' || role.key === 'soporte')) {
      change.legacy_role = role.key
    }
  }
  if (patch.suspend !== undefined) {
    const wantsSuspended = patch.suspend
    const isSuspended = before.suspended_at !== null
    if (wantsSuspended !== isSuspended) {
      change.suspend = wantsSuspended
    }
  }
  if (patch.display_name !== undefined) {
    change.display_name = patch.display_name.trim()
  }

  if (Object.keys(change).length === 0) {
    return before
  }

  // The write goes through `admin_update_profile`: the change AND its audit
  // entry land in the same transaction. Two separate calls would leave a role
  // changed with no trail whenever the second one failed.
  const { error } = await admin.rpc('admin_update_profile', {
    p_profile_id: id,
    p_role_key: change.role_key ?? null,
    p_suspend: change.suspend ?? null,
    p_display_name: change.display_name ?? null,
    p_actor: actorId,
  })
  if (error) throw error

  return {
    ...before,
    ...(change.role_key !== undefined ? { role_key: change.role_key } : {}),
    ...(change.legacy_role !== undefined ? { role: change.legacy_role } : {}),
    ...(change.suspend !== undefined
      ? {
          suspended_at: change.suspend ? new Date().toISOString() : null,
          suspended_by: change.suspend ? actorId : null,
        }
      : {}),
    ...(change.display_name !== undefined ? { display_name: change.display_name } : {}),
  } as UserWithProfile
}

export interface CreateUserInput {
  email: string
  /** Temporary password the user can change after signing in. */
  password: string
  display_name?: string | null
  /** Slug of the role to grant. Defaults to the least-privileged shipped role. */
  role_key?: string
}

/**
 * Creates an account and configures its profile.
 *
 * The profile row is NOT inserted here. A trigger — `handle_new_user`, an
 * AFTER INSERT on auth.users — already creates it, with `display_name` derived
 * from the email and `role = 'soporte'`. Inserting a second one violates
 * profiles_pkey, so this function's job is to *enrich* the row the trigger
 * made, not to create it.
 *
 * (Unit tests could not have caught the duplicate-insert shape: a mock has no
 * triggers. The live smoke test hit `profiles_pkey` on the first run.)
 *
 * Two steps, and the second must land:
 *
 *   1. An auth user. This is the identity — it can sign in.
 *   2. The profile gets its role and its name.
 *
 * Step 2 is not optional bookkeeping. A profile left at the trigger's default
 * is a `soporte` whose name is its email — an admin who asked for an admin
 * would get a support account, and no error. So if the update fails we delete
 * the auth user we just made rather than leave an account that exists with
 * the wrong powers. profiles.id cascades from auth.users, so the row goes
 * with it.
 */
export async function createUser(
  input: CreateUserInput,
  actorId: string,
): Promise<UserWithProfile> {
  const admin = createSupabaseAdminClient()
  const email = input.email.trim().toLowerCase()
  const roleKey = input.role_key ?? 'soporte'
  const name = input.display_name?.trim() ?? ''

  // Resolve the role before touching Auth: creating the identity first and
  // discovering the role slug is wrong afterwards leaves the same orphan.
  const { data: role } = await admin
    .from('roles')
    .select('key, is_system')
    .eq('key', roleKey)
    .maybeSingle<{ key: string; is_system: boolean }>()
  if (!role) {
    throw new UserValidationError('role_not_found', `El rol "${roleKey}" no existe`)
  }

  const { data: created, error: authErr } = await admin.auth.admin.createUser({
    email,
    password: input.password,
    email_confirm: true,
    // The trigger reads display_name out of this metadata, so the row is
    // already close to correct even if the update below never runs.
    user_metadata: { display_name: name || null },
  })
  if (authErr || !created?.user) {
    const msg = authErr?.message ?? 'auth rejected the request'
    // Supabase reports a re-registration in several shapes depending on
    // version. Treat the recognizable ones as a conflict, not a 500.
    if (/already (been )?(registered|exists)/i.test(msg)) {
      throw new UserValidationError('email_taken', 'Ya existe una cuenta con ese email')
    }
    throw new UserValidationError('auth_error', msg)
  }

  const newId = created.user.id
  const profileUpdate: Record<string, unknown> = {
    role_key: role.key,
    created_by: actorId,
  }
  if (name) profileUpdate.display_name = name
  // Only the shipped slugs may land in the legacy constrained column.
  if (role.is_system && ['admin', 'supervisor', 'soporte'].includes(role.key)) {
    profileUpdate.role = role.key
  }

  const { error: pErr } = await admin
    .from('profiles')
    .update(profileUpdate)
    .eq('id', newId)

  if (pErr) {
    // Compensate: profiles.id cascades from auth.users, so removing the
    // identity removes the row too — no half-account survives.
    //
    // Swallowed on purpose, and swallowed with try/catch rather than
    // `.catch()`. The cleanup is best effort; the failure the admin needs to
    // read is the profile error. If the cleanup itself throws and escapes, it
    // replaces that message with something about the cleanup — both true and
    // useless.
    try {
      await admin.auth.admin.deleteUser(newId)
    } catch (cleanupErr) {
      console.warn(
        '[users] could not remove half-created account',
        newId,
        cleanupErr instanceof Error ? cleanupErr.message : cleanupErr,
      )
    }
    throw new UserValidationError('profile_failed', pErr.message)
  }

  return {
    id: newId,
    email,
    display_name: name || null,
    phone: null,
    role: (profileUpdate.role as UserWithProfile['role']) ?? 'soporte',
    role_key: role.key,
    avatar_url: null,
    suspended_at: null,
    deleted_at: null,
    created_at: created.user.created_at ?? null,
    last_sign_in_at: null,
  }
}

export interface OwnProfilePatch {
  display_name?: string
  phone?: string | null
}

/**
 * Self-service profile edit (the profile page).
 *
 * Scoped to exactly two fields on purpose. Anything else about an account —
 * role, suspension — is an admin decision, so it is not reachable from here
 * even though the same table holds it. Narrowing the write at the type level
 * is what keeps a future field from being added to this function by accident.
 *
 * Both values are normalized to '' / null rather than rejected when empty:
 * "I don't want to publish my number" is a legitimate answer, not an error.
 */
export async function updateOwnProfile(
  id: string,
  patch: OwnProfilePatch,
): Promise<Pick<UserWithProfile, 'id' | 'display_name' | 'phone'>> {
  const admin = createSupabaseAdminClient()
  const update: Record<string, unknown> = {}

  if (patch.display_name !== undefined) {
    update.display_name = patch.display_name.trim().slice(0, 120)
  }
  if (patch.phone !== undefined) {
    const digits = patch.phone?.replace(/[^\d+\s()-]/g, '').trim() ?? ''
    update.phone = digits === '' ? null : digits.slice(0, 40)
  }

  if (Object.keys(update).length > 0) {
    const { error } = await admin.from('profiles').update(update).eq('id', id)
    if (error) throw error
  }

  const { data: profile, error } = await admin
    .from('profiles')
    .select('display_name, phone')
    .eq('id', id)
    .maybeSingle<{ display_name: string | null; phone: string | null }>()
  if (error) throw error

  return {
    id,
    display_name: profile?.display_name ?? null,
    phone: profile?.phone ?? null,
  }
}