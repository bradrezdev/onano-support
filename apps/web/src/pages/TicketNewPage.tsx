import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Search } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { RichTextEditor } from '@/components/ui/RichTextEditor'

interface Category {
  id: string
  parent_id: string | null
  name: string
  description: string | null
  children: Category[]
}

interface Contact {
  id: string
  whatsapp_number: string
  name: string
  email: string | null
  country: string | null
}

const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph' }] }

export default function TicketNewPage() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [description, setDescription] = useState<unknown>(EMPTY_DOC)
  const [contactId, setContactId] = useState<string>('')
  const [categoryId, setCategoryId] = useState<string>('')
  const [contacts, setContacts] = useState<Contact[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [contactSearch, setContactSearch] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      const [c, cat] = await Promise.all([
        api.get<{ data: Contact[] }>('/api/contacts'),
        api.get<{ data: Category[] }>('/api/categories'),
      ])
      setContacts(c.data)
      setCategories(cat.data)
    })()
  }, [])

  const filteredContacts = contacts.filter((c) =>
    contactSearch.trim()
      ? `${c.name} ${c.whatsapp_number} ${c.email ?? ''}`.toLowerCase().includes(contactSearch.toLowerCase())
      : true,
  )

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !contactId || !categoryId) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await api.post<{ data: { id: string } }>('/api/tickets', {
        contact_id: contactId,
        category_id: categoryId,
        name: name.trim(),
        description,
      })
      navigate(`/tickets/${res.data.id}`)
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-2xl font-semibold text-slate-900">Nuevo ticket</h1>

      <form className="space-y-4" onSubmit={submit}>
        <div>
          <label className="text-xs font-medium text-slate-600">Nombre</label>
          <input
            type="text"
            required
            maxLength={200}
            className="input mt-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div>
          <label className="text-xs font-medium text-slate-600">Contacto</label>
          {contacts.length === 0 ? (
            <div className="mt-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              Aún no hay contactos. Crea uno desde{' '}
              <a href="/contacts" className="font-medium underline">
                /contacts
              </a>{' '}
              antes.
            </div>
          ) : (
            <div className="card mt-1 max-h-48 overflow-y-auto">
              <div className="sticky top-0 border-b border-slate-100 bg-white px-3 py-2">
                <div className="relative">
                  <Search
                    size={14}
                    className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400"
                  />
                  <input
                    type="search"
                    placeholder="Filtrar por nombre o teléfono…"
                    className="input pl-7 text-sm"
                    value={contactSearch}
                    onChange={(e) => setContactSearch(e.target.value)}
                  />
                </div>
              </div>
              <ul className="divide-y divide-slate-100">
                {filteredContacts.map((c) => (
                  <li key={c.id}>
                    <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-slate-50">
                      <input
                        type="radio"
                        name="contact"
                        checked={contactId === c.id}
                        onChange={() => setContactId(c.id)}
                        className="accent-brand-600"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium text-slate-900">{c.name}</div>
                        <div className="truncate text-xs text-slate-500">
                          {c.whatsapp_number}
                          {c.country ? ` · ${c.country}` : ''}
                        </div>
                      </div>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div>
          <label className="text-xs font-medium text-slate-600">Categoría</label>
          {categories.length === 0 ? (
            <div className="mt-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              Aún no hay categorías. Pide a un admin que las cree en{' '}
              <a href="/categories" className="font-medium underline">
                /categories
              </a>
              .
            </div>
          ) : (
            <select
              required
              className="input mt-1"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
            >
              <option value="">— Selecciona —</option>
              {categories.map((root) => (
                <optgroup key={root.id} label={root.name}>
                  <option value={root.id}>{root.name}</option>
                  {root.children.map((sub) => (
                    <option key={sub.id} value={sub.id}>
                      {'  '}- {sub.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          )}
        </div>

        <div>
          <label className="text-xs font-medium text-slate-600">Descripción</label>
          <div className="mt-1">
            <RichTextEditor
              value={description}
              onChange={setDescription}
              placeholder="Describe el problema o solicitud…"
            />
          </div>
        </div>

        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={() => navigate(-1)}>
            Cancelar
          </button>
          <button type="submit" disabled={submitting} className="btn-primary">
            {submitting ? (
              <>Creando…</>
            ) : (
              <>
                <Plus size={16} />
                Crear ticket
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  )
}