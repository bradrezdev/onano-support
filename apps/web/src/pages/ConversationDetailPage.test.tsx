import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { api, ApiError } from '@/lib/api'
import ConversationDetailPage from './ConversationDetailPage'

/**
 * These cases cover the conversation authorization contract:
 * - A reason is required before reassigning.
 * - Reassign sends assigned_agent_id + reason + expected_version.
 * - 409 version_conflict reloads the detail and shows a specific message.
 * - 409 assignment_changed on send keeps the draft, reloads detail, and does not append the message.
 *
 * And the evidence contract (S7, S8, S12):
 * - A 403 withdraws the cached history of the chat from the screen.
 * - The draft lives under a key that carries the agent AND the chat.
 */

let currentConversationId = 'conv-1'

vi.mock('react-router-dom', () => ({
  useParams: vi.fn(() => ({ id: currentConversationId })),
  Link: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props}>{children}</a>
  ),
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(),
    patch: vi.fn(),
    post: vi.fn(),
    del: vi.fn(),
  },
  ApiError: class ApiError extends Error {
    status: number
    code: string
    constructor(status: number, code: string, message: string) {
      super(message)
      this.status = status
      this.code = code
    }
  },
}))

const mockedApi = {
  get: vi.mocked(api.get),
  patch: vi.mocked(api.patch),
  post: vi.mocked(api.post),
  del: vi.mocked(api.del),
}

const adminProfile = {
  id: 'admin-1',
  role: 'admin' as const,
  role_key: 'admin',
  permissions: [
    'conversation.assign',
    'conversation.reassign',
    'ticket.reply',
  ] as const,
}

const store = {
  profile: adminProfile,
}

vi.mock('@/stores/auth', () => ({
  useAuthStore: (selector: (s: typeof store) => unknown) => selector(store),
}))

const baseDetail = {
  data: {
    conversation: {
      id: 'conv-1',
      contact_id: 'contact-1',
      assigned_agent_id: 'agent-1',
      status: 'open' as const,
      last_message_at: new Date().toISOString(),
      last_message_preview: 'Hola',
      unread_count: 0,
      created_at: new Date().toISOString(),
      contact: { id: 'contact-1', whatsapp_number: '+521234567890', name: 'Juan' },
      assignment_version: 1,
    },
    messages: [
      {
        id: 'msg-1',
        conversation_id: 'conv-1',
        direction: 'in' as const,
        body: 'Hola',
        twilio_sid: null,
        twilio_status: null,
        sent_by_id: null,
        created_at: new Date().toISOString(),
      },
    ],
  },
}

const otherDetail = {
  data: {
    conversation: {
      ...baseDetail.data.conversation,
      id: 'conv-2',
      contact: { id: 'contact-2', whatsapp_number: '+521234567891', name: 'María' },
    },
    messages: [
      {
        id: 'msg-9',
        conversation_id: 'conv-2',
        direction: 'in' as const,
        body: 'Mensaje de otro cliente',
        twilio_sid: null,
        twilio_status: null,
        sent_by_id: null,
        created_at: new Date().toISOString(),
      },
    ],
  },
}

const agents = {
  data: [{ id: 'agent-2', display_name: 'María', role: 'supervisor' as const }],
}

/**
 * The jsdom environment of this repo has no localStorage: Node's own
 * experimental `localStorage` global shadows jsdom's and answers undefined
 * without `--localstorage-file`. The browser has one; the test installs an
 * equivalent so the draft store can be observed.
 */
function installLocalStorage(): Storage {
  const map = new Map<string, string>()
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v)
    },
    removeItem: (k: string) => {
      map.delete(k)
    },
    clear: () => {
      map.clear()
    },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size
    },
  } as Storage
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  })
  return storage
}

function setupGets() {
  mockedApi.get.mockImplementation((path: string) => {
    if (path === '/api/conversations/conv-1') return Promise.resolve(baseDetail)
    if (path === '/api/conversations/conv-2') return Promise.resolve(otherDetail)
    if (path === '/api/conversations/conv-1/tickets') return Promise.resolve({ data: [] })
    if (path === '/api/conversations/conv-2/tickets') return Promise.resolve({ data: [] })
    if (path === '/api/users/assignable') return Promise.resolve(agents)
    return Promise.reject(new Error(`Unexpected GET ${path}`))
  })
}

beforeEach(() => {
  cleanup()
  mockedApi.get.mockReset()
  mockedApi.patch.mockReset()
  mockedApi.post.mockReset()
  mockedApi.del.mockReset()
  store.profile = adminProfile
  currentConversationId = 'conv-1'
  installLocalStorage()
  localStorage.clear()
})

async function renderLoaded() {
  setupGets()
  const view = render(<ConversationDetailPage />)
  await waitFor(() => expect(screen.getByText('Juan')).toBeTruthy())
  return view
}

function draftBox(): HTMLTextAreaElement {
  return screen.getByPlaceholderText('Escribe tu respuesta…') as HTMLTextAreaElement
}

describe('ConversationDetailPage — send', () => {
  it('shows a specific warning on 409 assignment_changed, keeps the draft and does not append the message', async () => {
    mockedApi.post.mockRejectedValue(
      new ApiError(409, 'assignment_changed', 'El chat ya no es tuyo'),
    )

    await renderLoaded()

    const textarea = screen.getByPlaceholderText('Escribe tu respuesta…')
    fireEvent.change(textarea, { target: { value: 'Respuesta de prueba' } })

    fireEvent.click(screen.getByRole('button', { name: /enviar/i }))

    await waitFor(() =>
      expect(screen.getByText(/cambió de titular mientras redactabas/i)).toBeTruthy(),
    )

    expect((textarea as HTMLTextAreaElement).value).toBe('Respuesta de prueba')
    expect(mockedApi.get).toHaveBeenCalledWith('/api/conversations/conv-1')
    expect(screen.getAllByText('Cliente').length).toBe(1)
  })
})

describe('ConversationDetailPage — reassign', () => {  it('does not call the API when the reason is empty and shows the reason warning', async () => {
    await renderLoaded()

    fireEvent.change(screen.getByLabelText('Reasignar conversación'), {
      target: { value: 'agent-2' },
    })

    fireEvent.click(screen.getByRole('button', { name: /transferir/i }))

    await waitFor(() =>
      expect(screen.getByText('Indica el motivo de la transferencia')).toBeTruthy(),
    )

    expect(mockedApi.patch).not.toHaveBeenCalled()
  })

  it('sends assigned_agent_id, reason and expected_version from the loaded detail', async () => {
    mockedApi.patch.mockResolvedValue({ data: {} })

    await renderLoaded()

    fireEvent.change(screen.getByLabelText('Reasignar conversación'), {
      target: { value: 'agent-2' },
    })
    fireEvent.change(screen.getByPlaceholderText('Motivo de la transferencia'), {
      target: { value: 'Necesito ayuda' },
    })

    fireEvent.click(screen.getByRole('button', { name: /transferir/i }))

    await waitFor(() =>
      expect(mockedApi.patch).toHaveBeenCalledWith('/api/conversations/conv-1', {
        assigned_agent_id: 'agent-2',
        reason: 'Necesito ayuda',
        expected_version: 1,
      }),
    )
  })

  it('shows a specific warning and reloads the detail on 409 version_conflict', async () => {
    mockedApi.patch.mockRejectedValue(
      new ApiError(409, 'version_conflict', 'Conflicto de versión'),
    )

    await renderLoaded()

    fireEvent.change(screen.getByLabelText('Reasignar conversación'), {
      target: { value: 'agent-2' },
    })
    fireEvent.change(screen.getByPlaceholderText('Motivo de la transferencia'), {
      target: { value: 'Necesito ayuda' },
    })

    fireEvent.click(screen.getByRole('button', { name: /transferir/i }))

    await waitFor(() =>
      expect(screen.getByText(/cambió mientras lo transferías/i)).toBeTruthy(),
    )

    expect(mockedApi.get).toHaveBeenCalledWith('/api/conversations/conv-1')
  })
})

describe('ConversationDetailPage — borrador aislado por (agente, chat)', () => {
  it('guarda el borrador con la clave del agente y del chat', async () => {
    await renderLoaded()

    fireEvent.change(draftBox(), { target: { value: 'Respuesta de prueba' } })

    expect(localStorage.getItem('crm:draft:admin-1:conv-1')).toBe('Respuesta de prueba')
  })

  it('el borrador sobrevive a un recarga', async () => {
    await renderLoaded()

    fireEvent.change(draftBox(), { target: { value: 'Se queda' } })

    cleanup()
    setupGets()
    render(<ConversationDetailPage />)

    await waitFor(() => expect(draftBox().value).toBe('Se queda'))
  })

  it('otro chat no muestra el borrador del chat anterior', async () => {
    const view = await renderLoaded()

    fireEvent.change(draftBox(), { target: { value: 'Secreto de conv-1' } })

    currentConversationId = 'conv-2'
    view.rerender(<ConversationDetailPage />)

    await waitFor(() => expect(screen.getByText('María')).toBeTruthy())
    expect(draftBox().value).toBe('')
    expect(localStorage.getItem('crm:draft:admin-1:conv-1')).toBe('Secreto de conv-1')
  })

  it('otro agente en la misma máquina no ve el borrador', async () => {
    const view = await renderLoaded()

    fireEvent.change(draftBox(), { target: { value: 'Secreto de agent-1' } })

    store.profile = { ...adminProfile, id: 'agent-9' }
    view.rerender(<ConversationDetailPage />)

    await waitFor(() => expect(draftBox().value).toBe(''))
    expect(localStorage.getItem('crm:draft:admin-1:conv-1')).toBe('Secreto de agent-1')
    expect(localStorage.getItem('crm:draft:agent-9:conv-1')).toBeNull()
  })

  it('al enviar el mensaje el borrador se borra', async () => {
    mockedApi.post.mockResolvedValue({
      data: {
        id: 'msg-2',
        conversation_id: 'conv-1',
        direction: 'out',
        body: 'Respuesta de prueba',
        twilio_sid: null,
        twilio_status: null,
        sent_by_id: null,
        created_at: new Date().toISOString(),
      },
    })

    await renderLoaded()

    fireEvent.change(draftBox(), { target: { value: 'Respuesta de prueba' } })
    fireEvent.click(screen.getByRole('button', { name: /enviar/i }))

    await waitFor(() =>
      expect(localStorage.getItem('crm:draft:admin-1:conv-1')).toBeNull(),
    )
    expect(draftBox().value).toBe('')
  })
})

describe('ConversationDetailPage — 403 (ya no tienes acceso)', () => {
  it('retira el historial y el borrador de la pantalla', async () => {
    localStorage.setItem('crm:draft:admin-1:conv-1', 'Secreto del agente')
    mockedApi.get.mockImplementation((path: string) => {
      if (path === '/api/conversations/conv-1') {
        return Promise.reject(new ApiError(403, 'forbidden', 'No tienes acceso'))
      }
      return Promise.resolve({ data: [] })
    })

    render(<ConversationDetailPage />)

    await waitFor(() =>
      expect(screen.getByText(/ya no tienes acceso a esta conversación/i)).toBeTruthy(),
    )
    expect(screen.queryByText('Hola')).toBeNull()
    expect(screen.queryByPlaceholderText('Escribe tu respuesta…')).toBeNull()
    expect(localStorage.getItem('crm:draft:admin-1:conv-1')).toBeNull()
  })

  it('un 403 en un chat no impide abrir otro chat', async () => {
    mockedApi.get.mockImplementation((path: string) => {
      if (path === '/api/conversations/conv-1') {
        return Promise.reject(new ApiError(403, 'forbidden', 'No tienes acceso'))
      }
      if (path === '/api/conversations/conv-2') return Promise.resolve(otherDetail)
      return Promise.resolve({ data: [] })
    })

    const view = render(<ConversationDetailPage />)
    await waitFor(() =>
      expect(screen.getByText(/ya no tienes acceso a esta conversación/i)).toBeTruthy(),
    )

    currentConversationId = 'conv-2'
    view.rerender(<ConversationDetailPage />)

    await waitFor(() => expect(screen.getByText('María')).toBeTruthy())
    expect(screen.queryByText(/ya no tienes acceso a esta conversación/i)).toBeNull()
  })
})
