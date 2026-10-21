import { Navigate, Outlet } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth'
import { canWith, type Permission } from '@/lib/permissions'

interface Props {
  /** Any one of these keys is enough to render the route. */
  allow: Permission[]
}

/**
 * Route guard by permission, not by role name (R2).
 *
 * The backend already rejects the request; this only avoids rendering a page
 * that is guaranteed to fail. A custom role granted the key gets the page.
 */
export function RoleGuard({ allow }: Props) {
  const profile = useAuthStore((s) => s.profile)
  if (!profile) return <Navigate to="/login" replace />
  if (!allow.some((p) => canWith(profile, p))) return <Navigate to="/403" replace />
  return <Outlet />
}