import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth'

export function ProtectedRoute() {
  const { initialized, session } = useAuthStore()
  const location = useLocation()

  if (!initialized) {
    return (
      <div className="flex h-screen items-center justify-center text-slate-500">
        Cargando…
      </div>
    )
  }

  if (!session) {
    return <Navigate to="/login" replace state={{ redirect: location.pathname }} />
  }

  return <Outlet />
}