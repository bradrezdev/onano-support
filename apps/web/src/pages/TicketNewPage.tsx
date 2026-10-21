import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
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

interface Agent {
  id: string
  display_name: string | null
  role_key: string
}

interface Project {
  id: string
  name: string
  color: string
  flows: { id: string; name: string }[]
}

const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph' }] }

/**
 * New ticket, with inline contact creation (T3).
 *
 * "Buscar cliente o crearlo ahí mismo si no existe" — when the search comes
 * up empty, the same screen offers to create the contact rather than sending
 * the user to another page and losing the ticket they were writing.
 *
 * Duplicate protection (recommendation 15): the button is disabled once the
 * typed phone matches an existing contact, because two records for one person
 * split their history.
 */
export default function TicketNewPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [name, setName] = useState('')
  const [description, setDescription] = useState<unknown>(EMPTY_DOC)
  const [contactId, setContactId] = useState<string>('')
  const [categoryId, setCategoryId] = useState<string>('')
  const [contacts, setContacts] = useState<Contact[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  // Assignment at creation (issues 3, 5 and 9): who takes it, and which
  // project lane it enters. A ticket created with no project never shows up on
  // the board, because the pipeline filters on theme_id != null — so choosing
  // here is the difference between a ticket that exists and a ticket anyone
  // can find.
  const [agents, setAgents] = useState<Agent[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [assignedTo, setAssignedTo] = useState<string>('')
  const [projectId, setProjectId] = useState<string>('')
  const [flowId, setFlowId] = useState<string>('')
  // True when the optional pickers could not be loaded. Distinguishes "you
  // have no projects" from "we could not ask", which look identical otherwise.
  const [pickersUnavailable, setPickersUnavailable] = useState(false)
  const [pickersLoading, setPickersLoading] = useState(true)
  const [contactSearch, setContactSearch] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // T3 / C2: the ficha links here with a contact already chosen.
  const [showNewContact, setShowNewContact] = useState(false)
  const [newContact, setNewContact] = useState({ whatsapp_number: '', name: '', email: '' })
  const [creatingContact, setCreatingContact] = useState(false)
  const [contactError, setContactError] = useState<string | null>(null)

  const searchTerm = contactSearch.trim().toLowerCase()
  const existingMatches = searchTerm
    ? contacts.filter((c) =>
        `${c.name} ${c.whatsapp_number} ${c.email ?? ''}`.toLowerCase().includes(searchTerm),
      )
    : []

  // A phone that already belongs to someone is not a new contact.
  const phoneAlreadyExists = contacts.some(
    (c) =>
      c.whatsapp_number.replace(/\D/g, '').length > 6 &&
      newContact.whatsapp_number.replace(/\D/g, '') === c.whatsapp_number.replace(/\D/g, ''),
  )

  useEffect(() => {
    void (async () => {
      // Two independent groups, deliberately.
      //
      // The form is unusable without clients and categories, so those two fail
      // together. Assignment and project are optional extras, and they are not
      // guaranteed to be readable: GET /api/themes needs `conversation.read`,
      // which a custom role holding only `ticket.create` does not have. One
      // Promise.all over all four meant that 403 also took the client list and
      // the category list down with it — a role configured legitimately could
      // not open the form at all.
      try {
        const [c, cat] = await Promise.all([
          api.get<{ data: Contact[] }>('/api/contacts'),
          api.get<{ data: Category[] }>('/api/categories'),
        ])
        setContacts(c.data)
        setCategories(cat.data)
      } catch (err) {
        setError('No se pudieron cargar los clientes y categorías.')
        // eslint-disable-next-line no-console
        console.warn('[ticket-new] core lookups failed', err)
      }

      try {
        const [ag, proj] = await Promise.all([
          api.get<{ data: Agent[] }>('/api/users/assignable'),
          api.get<{ data: Project[] }>('/api/themes'),
        ])
        setAgents(ag.data)
        setProjects(proj.data)
      } catch (err) {
        setPickersLoading(false)
        // Non-fatal: the ticket is still creatable, just unassigned and off the
        // board. Saying so beats rendering two permanently-empty selects.
        setPickersUnavailable(true)
        // eslint-disable-next-line no-console
        console.warn('[ticket-new] assignment lookups failed', err)
      }

      // The client ficha links here with the contact already chosen.
      const preset = searchParams.get('contact_id')
      if (preset) setContactId(preset)
      setPickersLoading(false)
    })()
  }, [searchParams])

  // Stages belong to a project. Switching project clears the stage rather than
  // leaving a flow from the previous one selected, which would save a
  // theme_id/flow_id pair that do not belong together.
  const selectedProject = projects.find((p) => p.id === projectId) ?? null
  function chooseProject(id: string) {
    setProjectId(id)
    setFlowId('')
  }

  const filteredContacts = searchTerm
    ? existingMatches
    : contacts

  async function createContact() {
    if (!newContact.name.trim() || !newContact.whatsapp_number.trim()) return
    setCreatingContact(true)
    setContactError(null)
    try {
      const res = await api.post<{ data: Contact }>('/api/contacts', {
        whatsapp_number: newContact.whatsapp_number.trim(),
        name: newContact.name.trim(),
        email: newContact.email.trim() || undefined,
      })
      // Select it immediately: the user came here to write a ticket, not to
      // manage the contact registry.
      setContacts((prev) => [...prev, res.data])
      setContactId(res.data.id)
      setShowNewContact(false)
      setContactSearch('')
      setNewContact({ whatsapp_number: '', name: '', email: '' })
    } catch (err) {
      setContactError((err as ApiError).message)
    } finally {
      setCreatingContact(false)
    }
  }

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
        // Null, never undefined: `undefined` would be dropped by JSON.stringify
        // and the column would keep its default, which is not the same as
        // "explicitly unassigned".
        assigned_to: assignedTo || null,
        theme_id: projectId || null,
        flow_id: flowId || null,
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
          <label className="text-xs font-medium text-slate-600">Cliente</label>
          {contacts.length === 0 ? (
            <div className="mt-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              Aún no hay clientes. Podés crear el primero acá mismo.
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
                    placeholder="Filtrar por nombre, teléfono o email…"
                    className="input pl-7 text-sm"
                    value={contactSearch}
                    onChange={(e) => setContactSearch(e.target.value)}
                  />
                </div>
              </div>
              {searchTerm && existingMatches.length === 0 && (
                <div className="border-b border-slate-100 bg-slate-50 px-3 py-2 text-sm text-slate-600">
                  Sin resultados para «{contactSearch}».
                </div>
              )}
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

          {/* T3: offer to create the contact right here instead of sending
              the user to another page and losing the ticket they were writing. */}
          <div className="mt-2">
            {!showNewContact ? (
              <button
                type="button"
                onClick={() => {
                  setShowNewContact(true)
                  // Carry the search term into the phone field: if they typed
                  // a number looking for someone, that number is the answer.
                  if (!newContact.whatsapp_number && /\d{6,}/.test(searchTerm)) {
                    setNewContact((n) => ({ ...n, whatsapp_number: contactSearch.trim() }))
                  }
                }}
                className="btn-ghost w-full justify-center text-sm"
              >
                <Plus size={14} />
                {contacts.length === 0
                  ? 'Crear cliente'
                  : 'No es ninguno — crear cliente'}
              </button>
            ) : (
              <div className="space-y-2 rounded-md border border-slate-200 p-3">
                <p className="text-xs font-medium text-slate-600">Nuevo cliente</p>
                <input
                  type="tel"
                  placeholder="WhatsApp (E.164)"
                  className="input text-sm"
                  value={newContact.whatsapp_number}
                  onChange={(e) =>
                    setNewContact({ ...newContact, whatsapp_number: e.target.value })
                  }
                />
                <input
                  type="text"
                  placeholder="Nombre"
                  className="input text-sm"
                  value={newContact.name}
                  onChange={(e) => setNewContact({ ...newContact, name: e.target.value })}
                />
                <input
                  type="email"
                  placeholder="Email (opcional)"
                  className="input text-sm"
                  value={newContact.email}
                  onChange={(e) => setNewContact({ ...newContact, email: e.target.value })}
                />

                {phoneAlreadyExists && (
                  <p className="text-xs text-amber-700">
                    Ese teléfono ya existe entre tus clientes. Buscalo en la lista
                    para no duplicar su historial.
                  </p>
                )}
                {contactError && <p className="text-xs text-red-700">{contactError}</p>}

                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    className="btn-ghost text-sm"
                    onClick={() => setShowNewContact(false)}
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    className="btn-primary text-sm"
                    disabled={
                      creatingContact ||
                      phoneAlreadyExists ||
                      !newContact.name.trim() ||
                      !newContact.whatsapp_number.trim()
                    }
                    onClick={() => void createContact()}
                  >
                    {creatingContact ? 'Creando…' : 'Crear y usar'}
                  </button>
                </div>
              </div>
            )}
          </div>
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

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="text-xs font-medium text-slate-600" htmlFor="new-assignee">
              Asignar a
            </label>
            <select
              id="new-assignee"
              className="input mt-1"
              // Disabled while loading: a select showing only its placeholder
              // reads as "there is nobody to assign to", which is a different
              // and wrong answer from "we have not asked yet".
              disabled={pickersLoading || pickersUnavailable}
              value={assignedTo}
              onChange={(e) => setAssignedTo(e.target.value)}
            >
              <option value="">— Sin asignar —</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.display_name?.trim() || a.role_key}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs font-medium text-slate-600" htmlFor="new-project">
              Proyecto
            </label>
            <select
              id="new-project"
              className="input mt-1"
              disabled={pickersLoading || pickersUnavailable}
              value={projectId}
              onChange={(e) => chooseProject(e.target.value)}
            >
              <option value="">— Sin proyecto —</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {pickersUnavailable && (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            No se pudo cargar la lista de personas y proyectos. Podés crear el
            ticket igual y asignarlo después desde su detalle.
          </p>
        )}

        {selectedProject && (
          <div>
            <label className="text-xs font-medium text-slate-600" htmlFor="new-flow">
              Fase
            </label>
            {selectedProject.flows.length === 0 ? (
              <p className="mt-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                «{selectedProject.name}» todavía no tiene fases. Podés crearlas en
                Proyectos.
              </p>
            ) : (
              <select
                id="new-flow"
                className="input mt-1"
                value={flowId}
                onChange={(e) => setFlowId(e.target.value)}
              >
                <option value="">— Primera fase —</option>
                {selectedProject.flows.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            )}
            <p className="mt-1 text-xs text-slate-500">
              Sin proyecto, el ticket no aparece en el tablero.
            </p>
          </div>
        )}

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