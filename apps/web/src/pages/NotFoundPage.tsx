import { Link } from 'react-router-dom'

export function NotFoundPage() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="card max-w-sm p-6 text-center">
        <h1 className="text-xl font-semibold text-slate-900">404</h1>
        <p className="mt-1 text-sm text-slate-500">No encontramos esa ruta.</p>
        <Link to="/inbox" className="btn-primary mt-4 inline-flex">
          Ir a bandeja
        </Link>
      </div>
    </div>
  )
}

export function ForbiddenPage() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="card max-w-sm p-6 text-center">
        <h1 className="text-xl font-semibold text-slate-900">403</h1>
        <p className="mt-1 text-sm text-slate-500">No tienes permisos para esa sección.</p>
        <Link to="/inbox" className="btn-primary mt-4 inline-flex">
          Volver a bandeja
        </Link>
      </div>
    </div>
  )
}