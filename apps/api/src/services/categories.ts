import { createSupabaseAdminClient } from '@/lib/supabase/admin'

export interface Category {
  id: string
  parent_id: string | null
  name: string
  description: string | null
  created_by: string
  created_at: string
  updated_at: string
}

export interface CategoryNode extends Category {
  children: CategoryNode[]
}

/**
 * Returns the full tree of categories (parents with nested children) sorted
 * by name. Each parent contains an empty `children` array if it has none.
 */
export async function listCategoryTree(): Promise<CategoryNode[]> {
  const admin = createSupabaseAdminClient()
  const { data, error } = await admin
    .from('categories')
    .select('id, parent_id, name, description, created_by, created_at, updated_at')
    .order('name', { ascending: true })

  if (error) throw error
  const rows = (data ?? []) as Category[]

  const byParent = new Map<string | null, CategoryNode[]>()
  for (const r of rows) {
    const node: CategoryNode = { ...r, children: [] }
    const list = byParent.get(r.parent_id) ?? []
    list.push(node)
    byParent.set(r.parent_id, list)
  }
  for (const node of byParent.get(null) ?? []) {
    attachChildren(node, byParent)
  }
  return byParent.get(null) ?? []
}

function attachChildren(
  node: CategoryNode,
  byParent: Map<string | null, CategoryNode[]>,
): void {
  const children = byParent.get(node.id) ?? []
  node.children = children
  for (const c of children) attachChildren(c, byParent)
}

export async function findCategoryById(id: string): Promise<Category | null> {
  const admin = createSupabaseAdminClient()
  const { data, error } = await admin
    .from('categories')
    .select('id, parent_id, name, description, created_by, created_at, updated_at')
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  return (data as Category | null) ?? null
}

export async function categoryHasChildren(categoryId: string): Promise<boolean> {
  const admin = createSupabaseAdminClient()
  const { count, error } = await admin
    .from('categories')
    .select('id', { count: 'exact', head: true })
    .eq('parent_id', categoryId)
  if (error) throw error
  return (count ?? 0) > 0
}