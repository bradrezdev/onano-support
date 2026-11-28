import { useEffect, useState } from 'react'
import { Save, User } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

/**
 * Profile — the account holder's own name and phone.
 *
 * Scope is two fields on purpose. Role, suspension and account existence are
 * admin decisions; this page is where someone fills in what only they know.
 * The allowlist lives on the server (PATCH /api/me), not here, so widening this
 * form would not grant anything on its own.
 *
 * Email is shown read-only: it is the login identity, and changing it is an
 * auth-level operation, not a profile edit.
 */
export default function ProfilePage() {
  const profile = useAuthStore((s) => s.profile)
  const user = useAuthStore((s) => s.user)
  const refreshProfile = useAuthStore((s) => s.refreshProfile)

  const [displayName, setDisplayName] = useState('')
  const [phone, setPhone] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  // Whether the person already touched the form. `dirty` is what keeps the
  // arrival of /api/me from wiping what they typed.
  const [dirty, setDirty] = useState(false)

  // Seed from the resolved profile once it arrives; /api/me is async, so the
  // first render legitimately has nothing to show.
  //
  // The seeding is skipped when the form is already dirty. Without that
  // guard, typing while your profile was still loading got overwritten the
  // moment /api/me answered: the field went back to the old name and the
  // save persisted the previous value while the UI said "Perfil guardado".
  useEffect(() => {
    if (!profile || dirty) return
    setDisplayName(profile.display_name ?? '')
    setPhone(profile.phone ?? '')
  }, [profile, dirty])

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      await api.patch('/api/me', {
        display_name: displayName.trim(),
        phone: phone.trim() || null,
      })
      // Re-read /api/me so the Topbar and every permission-gated control see
      // the new name without a reload.
      await refreshProfile()
      setSaved(true)
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <header className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-100 text-brand-700">
          <User size={18} />
        </div>
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Mi perfil</h1>
          <p className="mt-1 text-sm text-slate-500">
            Así te ven los demás cuando asignan un ticket.
          </p>
        </div>
      </header>

      <form onSubmit={save} className="card space-y-4 p-5">
        <div>
          <label className="text-xs font-medium text-slate-600" htmlFor="profile-email">
            Email
          </label>
          {/* Read-only on purpose: the email is the login identity. Changing it
              is an auth operation, not a profile field. */}
          <input
            id="profile-email"
            type="email"
            className="input mt-1 bg-slate-50 text-slate-500"
            value={profile?.id ? (user?.email ?? '') : ''}
            readOnly
            disabled
          />
        </div>

        <div>
          <label className="text-xs font-medium text-slate-600" htmlFor="profile-name">
            Nombre
          </label>
          <input
            id="profile-name"
            type="text"
            maxLength={120}
            placeholder="Cómo te llamamos"
            className="input mt-1"
            value={displayName}
            onChange={(e) => {
              setDirty(true)
              setDisplayName(e.target.value)
            }}
          />
          <p className="mt-1 text-xs text-slate-500">
            Si lo dejás vacío, los listados muestran tu email.
          </p>
        </div>

        <div>
          <label className="text-xs font-medium text-slate-600" htmlFor="profile-phone">
            Teléfono
          </label>
          <input
            id="profile-phone"
            type="tel"
            maxLength={40}
            placeholder="+52 555 123 4567"
            className="input mt-1"
            value={phone}
            onChange={(e) => {
              setDirty(true)
              setPhone(e.target.value)
            }}
          />
          <p className="mt-1 text-xs text-slate-500">
            Para que te localize el equipo. Opcional.
          </p>
        </div>

        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}
        {saved && !error && (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            Perfil guardado.
          </div>
        )}

        <div className="flex justify-end">
          <button type="submit" disabled={saving} className="btn-primary">
            <Save size={16} />
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </form>
    </div>
  )
}