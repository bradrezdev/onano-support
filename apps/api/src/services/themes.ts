import { createSupabaseAdminClient } from '@/lib/supabase/admin'

export interface Theme {
  id: string
  name: string
  description: string | null
  color: string
  position: number
  created_by: string
  created_at: string
  updated_at: string
}

export interface Flow {
  id: string
  theme_id: string
  name: string
  description: string | null
  position: number
  is_terminal: boolean
  /** Recommendation 5: which shared group this phase belongs to. */
  group_key: string | null
  created_at: string
  updated_at: string
}

/** Recommendation 5: the fixed shared vocabulary every project's phases map onto. */
export interface FlowGroup {
  key: string
  label: string
  position: number
  color: string
}

export interface ThemeWithFlows extends Theme {
  flows: Flow[]
  groups: FlowGroup[]
}

export class ThemeError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export async function listThemesWithFlows(): Promise<ThemeWithFlows[]> {
  const admin = createSupabaseAdminClient()
  const [
    { data: themes, error: tErr },
    { data: flows, error: fErr },
    { data: groups, error: gErr },
  ] = await Promise.all([
    admin.from('themes').select('*').order('position', { ascending: true }),
    admin.from('flows').select('*').order('position', { ascending: true }),
    admin.from('flow_groups').select('key, label, position, color').order('position', { ascending: true }),
  ])
  if (tErr) throw tErr
  if (fErr) throw fErr
  if (gErr) throw gErr

  // The group vocabulary is the same four entries for every project, so it
  // travels with the payload rather than costing another request per theme.
  const sharedGroups = (groups ?? []) as unknown as FlowGroup[]

  const byTheme = new Map<string, Flow[]>()
  for (const f of (flows ?? []) as unknown as Flow[]) {
    const list = byTheme.get(f.theme_id) ?? []
    list.push(f)
    byTheme.set(f.theme_id, list)
  }
  return ((themes ?? []) as unknown as Theme[]).map((t) => ({
    ...t,
    flows: byTheme.get(t.id) ?? [],
    groups: sharedGroups,
  }))
}

export async function findThemeOrThrow(id: string): Promise<Theme> {
  const admin = createSupabaseAdminClient()
  const { data, error } = await admin
    .from('themes')
    .select('*')
    .eq('id', id)
    .maybeSingle<Theme>()
  if (error) throw error
  if (!data) throw new ThemeError(404, 'not_found', 'Theme not found')
  return data
}

export async function findFlowOrThrow(id: string): Promise<Flow> {
  const admin = createSupabaseAdminClient()
  const { data, error } = await admin
    .from('flows')
    .select('*')
    .eq('id', id)
    .maybeSingle<Flow>()
  if (error) throw error
  if (!data) throw new ThemeError(404, 'not_found', 'Flow not found')
  return data
}

export async function createTheme(input: { name: string; description?: string | null; color?: string }, actorId: string): Promise<Theme> {
  const admin = createSupabaseAdminClient()
  // Place the new theme at the end of the list.
  const { count } = await admin
    .from('themes')
    .select('*', { count: 'exact', head: true })
  const position = (count ?? 0)
  const { data, error } = await admin
    .from('themes')
    .insert({
      name: input.name.trim(),
      description: input.description?.trim() || null,
      color: input.color ?? '#6366f1',
      position,
      created_by: actorId,
    })
    .select('*')
    .single<Theme>()
  if (error) {
    if (error.code === '23505') {
      throw new ThemeError(409, 'duplicate', `Theme "${input.name}" already exists`)
    }
    throw error
  }
  if (!data) throw new Error('insert returned no row')
  return data
}

export async function updateTheme(
  id: string,
  patch: { name?: string; description?: string | null; color?: string },
): Promise<Theme> {
  const admin = createSupabaseAdminClient()
  const update: Record<string, unknown> = {}
  if (patch.name !== undefined) update.name = patch.name.trim()
  if (patch.description !== undefined) update.description = patch.description?.trim() || null
  if (patch.color !== undefined) update.color = patch.color
  const { data, error } = await admin
    .from('themes')
    .update(update)
    .eq('id', id)
    .select('*')
    .single<Theme>()
  if (error) {
    if (error.code === '23505') {
      throw new ThemeError(409, 'duplicate', `Theme name conflict`)
    }
    throw error
  }
  if (!data) throw new Error('update returned no row')
  return data
}

export async function deleteTheme(id: string): Promise<void> {
  // Cascade delete: flows tied to this theme go via ON DELETE CASCADE.
  const admin = createSupabaseAdminClient()
  const { error } = await admin.from('themes').delete().eq('id', id)
  if (error) throw error
}

export async function createFlow(
  themeId: string,
  input: { name: string; description?: string | null; is_terminal?: boolean },
): Promise<Flow> {
  const admin = createSupabaseAdminClient()
  // Place at end of theme's flows.
  const { count } = await admin
    .from('flows')
    .select('*', { count: 'exact', head: true })
    .eq('theme_id', themeId)
  const position = (count ?? 0)
  const { data, error } = await admin
    .from('flows')
    .insert({
      theme_id: themeId,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      is_terminal: input.is_terminal ?? false,
      position,
    })
    .select('*')
    .single<Flow>()
  if (error) {
    if (error.code === '23505') {
      throw new ThemeError(409, 'duplicate', `Flow "${input.name}" already exists in this theme`)
    }
    throw error
  }
  if (!data) throw new Error('insert returned no row')
  return data
}

export async function updateFlow(
  id: string,
  patch: {
    name?: string
    description?: string | null
    is_terminal?: boolean
    /** Recommendation 5: file this phase into the shared vocabulary. */
    group_key?: string | null
  },
): Promise<Flow> {
  const admin = createSupabaseAdminClient()
  const update: Record<string, unknown> = {}
  if (patch.name !== undefined) update.name = patch.name.trim()
  if (patch.description !== undefined) update.description = patch.description?.trim() || null
  if (patch.is_terminal !== undefined) update.is_terminal = patch.is_terminal
  if (patch.group_key !== undefined) update.group_key = patch.group_key
  const { data, error } = await admin
    .from('flows')
    .update(update)
    .eq('id', id)
    .select('*')
    .single<Flow>()
  if (error) {
    if (error.code === '23505') {
      throw new ThemeError(409, 'duplicate', `Flow name conflict in this theme`)
    }
    throw error
  }
  if (!data) throw new Error('update returned no row')
  return data
}

export async function deleteFlow(id: string): Promise<void> {
  // Refuse if any ticket is in this flow.
  const admin = createSupabaseAdminClient()
  const { count, error: countErr } = await admin
    .from('tickets')
    .select('*', { count: 'exact', head: true })
    .eq('flow_id', id)
  if (countErr) throw countErr
  if ((count ?? 0) > 0) {
    throw new ThemeError(409, 'flow_in_use', 'Flow has tickets; move them first')
  }
  const { error } = await admin.from('flows').delete().eq('id', id)
  if (error) throw error
}

export async function reorderFlows(themeId: string, orderedIds: string[]): Promise<Flow[]> {
  const admin = createSupabaseAdminClient()
  // Update each flow with its new position. Done in parallel; safe because
  // the unique constraint is on (theme_id, name), not position.
  const updates = orderedIds.map((id, idx) =>
    admin.from('flows').update({ position: idx }).eq('id', id).eq('theme_id', themeId).select('*').single<Flow>(),
  )
  const results = await Promise.all(updates)
  for (const r of results) {
    if (r.error) throw r.error
  }
  return results.map((r) => r.data).filter((d): d is Flow => !!d).sort((a, b) => a.position - b.position)
}