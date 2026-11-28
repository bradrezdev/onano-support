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
 */

vi.mock('react-router-dom', () => ({
  useParams: vi.fn().mockReturnValue({ id: 'conv-1' }),
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

const agents = {
  data: [{ id: 'agent-2', display_name: 'María', role: 'supervisor' as const }],
}

function setupGets() {
  mockedApi.get.mockImplementation((path: string) => {
    if (path === '/api/conversations/conv-1') return Promise.resolve(baseDetail)
    if (path === '/api/conversations/conv-1/tickets') return Promise.resolve({ data: [] })
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
})

async function renderLoaded() {
  setupGets()
  render(<ConversationDetailPage />)
  await waitFor(() => expect(screen.getByText('Juan')).toBeTruthy())
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

describe('ConversationDetailPage — reassign', () => {
  it('does not call the API when the reason is empty and shows the reason warning', async () => {
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
