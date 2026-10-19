import { createSupabaseAdminClient } from '@/lib/supabase/admin'

export interface UserWithProfile {
  id: string
  email: string | null
  display_name: string | null
  role: 'admin' | 'supervisor' | 'soporte'
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
        .select('id, role, display_name, avatar_url, suspended_at, deleted_at')
        .order('display_name', { ascending: true }),
      admin.auth.admin.listUsers({ perPage: 1000 }),
    ])
  if (pErr) throw pErr
  if (uErr) throw uErr

  const profileById = new Map(
    ((profileRows ?? []) as { id: string; role: string | null; display_name: string | null; avatar_url: string | null; suspended_at: string | null; deleted_at: string | null }[]).map(
      (p) => [p.id, p],
    ),
  )
  return userList.users.map((u) => {
    const p = profileById.get(u.id)
    return {
      id: u.id,
      email: u.email ?? null,
      display_name: p?.display_name ?? null,
      role: (p?.role as UserWithProfile['role']) ?? 'soporte',
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
    .select('id, role, display_name, avatar_url, suspended_at, deleted_at')
    .eq('id', id)
    .maybeSingle<{
      id: string
      role: UserWithProfile['role']
      display_name: string | null
      avatar_url: string | null
      suspended_at: string | null
      deleted_at: string | null
    }>()
  if (pErr) throw pErr

  const { data, error } = await admin.auth.admin.getUserById(id)
  if (error) throw error
  return {
    id: data.user.id,
    email: data.user.email ?? null,
    display_name: profile?.display_name ?? null,
    role: profile?.role ?? 'soporte',
    avatar_url: profile?.avatar_url ?? null,
    suspended_at: profile?.suspended_at ?? null,
    deleted_at: profile?.deleted_at ?? null,
    created_at: data.user.created_at ?? null,
    last_sign_in_at: data.user.last_sign_in_at ?? null,
  }
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
  role?: UserWithProfile['role']
  suspend?: boolean
  display_name?: string
}

/**
 * Admin-only mutations on a profile. Guard rails:
 *   - admin cannot suspend themselves (would lock the workspace)
 *   - admin cannot demote themselves to non-admin (would lock the workspace)
 *   - cannot change role on a deleted user
 *
 * Suspended/deleted users are rejected at auth boundary (getCurrentUser) on
 * the next API call — no extra cache invalidation required for MVP.
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

  const update: Record<string, unknown> = {}
  if (patch.role !== undefined && patch.role !== before.role) {
    update.role = patch.role
  }
  if (patch.suspend !== undefined) {
    const wantsSuspended = patch.suspend
    const isSuspended = before.suspended_at !== null
    if (wantsSuspended !== isSuspended) {
      update.suspended_at = wantsSuspended ? new Date().toISOString() : null
      update.suspended_by = wantsSuspended ? actorId : null
    }
  }
  if (patch.display_name !== undefined) {
    update.display_name = patch.display_name.trim()
  }

  if (Object.keys(update).length === 0) {
    return before
  }

  const { error } = await admin.from('profiles').update(update).eq('id', id)
  if (error) throw error

  return { ...before, ...update } as UserWithProfile
}