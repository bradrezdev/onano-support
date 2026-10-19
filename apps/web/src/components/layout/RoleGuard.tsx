import { Navigate, Outlet } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth'
import type { Role } from '@/lib/permissions'

interface Props {
  allow: Role[]
}

export function RoleGuard({ allow }: Props) {
  const { profile } = useAuthStore()
  if (!profile) return <Navigate to="/login" replace />
  if (!allow.includes(profile.role)) return <Navigate to="/403" replace />
  return <Outlet />
}