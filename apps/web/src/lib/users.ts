import type { Role } from '@/lib/permissions'

export interface UserWithProfile {
  id: string
  email: string | null
  display_name: string | null
  role: Role
  avatar_url: string | null
  suspended_at: string | null
  deleted_at: string | null
  created_at: string | null
  last_sign_in_at: string | null
}

export interface UserWithCounts extends UserWithProfile {
  open_count: number
  closed_count: number
  total_count: number
}