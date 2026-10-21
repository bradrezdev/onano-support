import type { Permission } from '@/lib/permissions'

export interface Role {
  id: string
  key: string
  name: string
  description: string | null
  color: string
  is_system: boolean
  created_at: string
  permissions: Permission[]
  user_count: number
}

export interface PermissionMeta {
  key: Permission
  label: string
  group: string
}

/** Groups the catalogue for rendering, preserving catalogue order. */
export function groupPermissions(catalog: PermissionMeta[]): Array<{
  group: string
  items: PermissionMeta[]
}> {
  const map = new Map<string, PermissionMeta[]>()
  for (const p of catalog) {
    const list = map.get(p.group) ?? []
    list.push(p)
    map.set(p.group, list)
  }
  return [...map.entries()].map(([group, items]) => ({ group, items }))
}