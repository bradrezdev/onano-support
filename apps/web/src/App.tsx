import { useEffect } from 'react'
import { RouterProvider } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth'
import { loadRoleColors } from '@/lib/roleColors'
import { router } from '@/router'

export default function App() {
  const hydrate = useAuthStore((s) => s.hydrate)

  useEffect(() => {
    void hydrate()
    void loadRoleColors()
  }, [hydrate])

  return <RouterProvider router={router} />
}