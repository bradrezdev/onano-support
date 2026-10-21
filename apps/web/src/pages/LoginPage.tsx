import { useState, type FormEvent } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth'

interface LocationState {
  redirect?: string
}

export default function LoginPage() {
  const { session, signIn, signUp } = useAuthStore()
  const navigate = useNavigate()
  const location = useLocation()
  const redirect = (location.state as LocationState | null)?.redirect ?? '/inbox'

  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (session) return <Navigate to={redirect} replace />

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      if (mode === 'signin') {
        await signIn(email, password)
      } else {
        await signUp(email, password, displayName || undefined)
      }
      navigate(redirect, { replace: true })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <div className="card w-full max-w-sm p-6">
        <h1 className="mb-1 text-xl font-semibold text-slate-900">
          WhatsApp CRM
        </h1>
        <p className="mb-5 text-sm text-slate-500">
          {mode === 'signin' ? 'Iniciar sesión' : 'Crear cuenta'}
        </p>

        <form className="space-y-3" onSubmit={onSubmit}>
          {mode === 'signup' && (
            <>
              {/* Real labels, not placeholders. A placeholder disappears the
                  moment you type and is not reliably announced, so the field
                  loses its name exactly when the user is filling it in. */}
              <label htmlFor="login-name" className="sr-only">
                Nombre
              </label>
              <input
                id="login-name"
                type="text"
                required
                placeholder="Nombre"
                className="input"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                autoComplete="name"
              />
            </>
          )}
          <label htmlFor="login-email" className="sr-only">
            Correo
          </label>
          <input
            id="login-email"
            type="email"
            required
            placeholder="Correo"
            className="input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
          <label htmlFor="login-password" className="sr-only">
            Contraseña
          </label>
          <input
            id="login-password"
            type="password"
            required
            minLength={6}
            placeholder="Contraseña"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
          />
          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}
          <button
            type="submit"
            disabled={submitting}
            className="btn-primary w-full"
          >
            {submitting ? 'Enviando…' : mode === 'signin' ? 'Entrar' : 'Crear cuenta'}
          </button>
        </form>

        <button
          type="button"
          className="mt-4 w-full text-center text-sm text-brand-700 hover:underline"
          onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}
        >
          {mode === 'signin' ? '¿No tienes cuenta? Crear una' : '¿Ya tienes cuenta? Entrar'}
        </button>
      </div>
    </div>
  )
}