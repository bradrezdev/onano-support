import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth'
import { api, ApiError } from '@/lib/api'
import { Plus, Search, X } from 'lucide-react'

interface Contact {
  id: string
  whatsapp_number: string
  name: string
  email: string | null
  country: string | null
  country_code: string | null
  profile_pic_url: string | null
  created_at: string
  updated_at: string
}

export default function ContactsPage() {
  const profile = useAuthStore((s) => s.profile)
  const canCreate = !!profile
  const [contacts, setContacts] = useState<Contact[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [formOpen, setFormOpen] = useState(false)

  async function load(q?: string) {
    setLoading(true)
    setError(null)
    try {
      const url = q?.trim() ? `/api/contacts?q=${encodeURIComponent(q.trim())}` : '/api/contacts'
      const res = await api.get<{ data: Contact[] }>(url)
      setContacts(res.data)
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  function onSearch(e: React.FormEvent) {
    e.preventDefault()
    void load(search)
  }

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Contactos</h1>
          <p className="mt-1 text-sm text-slate-500">
            Personas que contactan por WhatsApp. Se pueden asignar a tickets.
          </p>
        </div>
        {canCreate && (
          <button
            type="button"
            className="btn-primary"
            onClick={() => setFormOpen(true)}
          >
            <Plus size={16} />
            Nuevo contacto
          </button>
        )}
      </header>

      <form className="flex max-w-md gap-2" onSubmit={onSearch}>
        <div className="relative flex-1">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
          />
          <input
            type="search"
            placeholder="Buscar por nombre…"
            className="input pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <button type="submit" className="btn-ghost">
          Buscar
        </button>
      </form>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="card p-6 text-sm text-slate-500">Cargando…</div>
      ) : contacts.length === 0 ? (
        <div className="card p-8 text-center text-sm text-slate-500">
          {search.trim() ? 'Sin resultados.' : 'Aún no hay contactos.'}
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Nombre</th>
                <th className="px-4 py-2 font-medium">WhatsApp</th>
                <th className="px-4 py-2 font-medium">Correo</th>
                <th className="px-4 py-2 font-medium">País</th>
                <th className="px-4 py-2 font-medium">Actualizado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {contacts.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2 font-medium text-slate-900">
                    <Link to={`/contacts/${c.id}`} className="hover:underline">
                      {c.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-slate-600">{c.whatsapp_number}</td>
                  <td className="px-4 py-2 text-slate-600">{c.email ?? '—'}</td>
                  <td className="px-4 py-2 text-slate-600">
                    {c.country ?? '—'}
                    {c.country_code && (
                      <span className="ml-1 rounded bg-slate-100 px-1.5 py-0.5 text-xs uppercase text-slate-500">
                        {c.country_code}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-500">
                    {new Date(c.updated_at).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {formOpen && (
        <ContactFormModal
          onClose={() => setFormOpen(false)}
          onSaved={async () => {
            setFormOpen(false)
            await load(search)
          }}
        />
      )}
    </div>
  )
}

function ContactFormModal({
  onClose,
  onSaved,
}: {
  onClose: () => void
  onSaved: () => void | Promise<void>
}) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [country, setCountry] = useState('')
  const [countryCode, setCountryCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !phone.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      await api.post('/api/contacts', {
        name: name.trim(),
        whatsapp_number: phone.trim(),
        email: email.trim() || null,
        country: country.trim() || null,
        country_code: countryCode.trim() || null,
      })
      await onSaved()
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"
      onClick={onClose}
    >
      <div className="card w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">Nuevo contacto</h2>
          <button type="button" className="btn-ghost px-2 py-1" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <form className="space-y-3" onSubmit={submit}>
          <div>
            <label className="text-xs font-medium text-slate-600">Nombre</label>
            <input
              type="text"
              required
              maxLength={200}
              autoFocus
              className="input mt-1"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600">WhatsApp (con prefijo país)</label>
            <input
              type="tel"
              required
              placeholder="+34612345678"
              className="input mt-1"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600">Correo (opcional)</label>
            <input
              type="email"
              className="input mt-1"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2">
              <label className="text-xs font-medium text-slate-600">País (opcional)</label>
              <input
                type="text"
                maxLength={80}
                placeholder="España"
                className="input mt-1"
                value={country}
                onChange={(e) => setCountry(e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-600">ISO-3166-1</label>
              <input
                type="text"
                maxLength={2}
                placeholder="es"
                className="input mt-1 uppercase"
                value={countryCode}
                onChange={(e) => setCountryCode(e.target.value)}
              />
            </div>
          </div>
          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" disabled={submitting} className="btn-primary">
              {submitting ? 'Guardando…' : 'Crear'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}