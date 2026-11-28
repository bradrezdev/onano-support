import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { Session } from '@supabase/supabase-js'
import { getSession } from '@/lib/supabase'
import TicketDetailPage from './TicketDetailPage'

/**
 * Evidencia de adjuntos (S1–S3, S9, S10):
 * - El listado, la vista previa y la descarga pasan SIEMPRE por la API: el
 *   navegador recibe bytes, no una URL firmada que sobrevive a la pérdida de
 *   permiso.
 * - Un 403 significa "ya no puedes ver esto": la fila y sus controles se van,
 *   y los bytes ya descargados se revocan.
 *
 * Estas pruebas ejercitan el cliente real (`@/lib/api`) contra un `fetch`
 * falso, así que también cubren el camino de bytes crudos.
 */

let currentTicketId = 't-1'

vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: currentTicketId }),
  useNavigate: () => vi.fn(),
  Link: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props}>{children}</a>
  ),
}))

vi.mock('@/lib/supabase', () => ({
  getSession: vi.fn().mockResolvedValue({ access_token: 'token-test' }),
  supabase: { auth: { onAuthStateChange: vi.fn() } },
}))

vi.mock('@/components/ui/RichTextEditor', () => ({
  RichTextEditor: () => <div data-testid="rich-editor" />,
  RichTextRenderer: ({ value }: { value: unknown }) => (
    <span data-testid="rich-text">
      {typeof value === 'string' ? value : JSON.stringify(value)}
    </span>
  ),
}))

const adminProfile = {
  id: 'agent-1',
  display_name: 'Ana',
  role: 'admin' as const,
  role_key: 'admin',
  permissions: ['ticket.reply', 'ticket.read'] as const,
}

const store = { profile: adminProfile as unknown }

vi.mock('@/stores/auth', () => ({
  useAuthStore: (selector: (s: typeof store) => unknown) => selector(store),
}))

const ticketFixture = {
  id: 't-1',
  name: 'Comprobante de pago',
  status: 'open',
  priority: 'normal',
  is_major: false,
  due_at: null,
  description: 'Pide el comprobante',
  description_plain: 'Pide el comprobante',
  contact_id: 'c-1',
  category_id: 'cat-1',
  assigned_to: 'agent-1',
  theme_id: null,
  flow_id: null,
  created_by: 'agent-1',
  closed_by: null,
  closed_at: null,
  reopened_by: null,
  reopened_at: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}

const attachmentFixture = {
  message_id: 'm-1',
  ticket_id: 't-1',
  body: 'Hola, ¿me mandas el comprobante?',
  direction: 'in' as const,
  created_at: new Date().toISOString(),
  note: null,
  has_file: true,
  filename: 'comprobante.png',
}

/** A pinned message that carries no file of its own. */
const textOnlyAttachmentFixture = {
  message_id: 'm-2',
  ticket_id: 't-1',
  body: 'Texto sin archivo',
  direction: 'in' as const,
  created_at: new Date().toISOString(),
  note: null,
  has_file: false,
  filename: null,
}

const messageFixture = {
  id: 'tm-1',
  ticket_id: 't-1',
  author_id: 'agent-1',
  body: 'Mensaje interno del ticket',
  body_plain: 'Mensaje interno del ticket',
  role_at_send: 'admin' as const,
  fade_step: 0,
  created_at: new Date().toISOString(),
}

const otherTicketFixture = {
  ...ticketFixture,
  id: 't-2',
  name: 'Otro ticket',
}

interface FetchPlan {
  ticket?: number
  attachments?: number
  message?: number
  messageCode?: string
  download?: number
  attachmentRows?: unknown[]
}
function jsonRes(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    blob: async () => new Blob([]),
    headers: { get: () => null },
  }
}

function bytesRes(
  contentType: string,
  contentDisposition: string | null,
  status = 200,
  payload = 'bytes',
) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({}),
    blob: async () => new Blob([payload], { type: contentType }),
    headers: {
      get: (name: string) => {
        const key = name.toLowerCase()
        if (key === 'content-type') return contentType
        if (key === 'content-disposition') return contentDisposition
        return null
      },
    },
  }
}

let fetchMock: ReturnType<typeof vi.fn>

function installFetch(plan: FetchPlan = {}) {
  fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input)
    // The route answers for the ticket the page is showing.
    const ticketId = url.match(/\/api\/tickets\/(t-\d+)/)?.[1] ?? 't-1'
    const ticket = ticketId === 't-1' ? ticketFixture : otherTicketFixture
    if (url.endsWith(`/api/tickets/${ticketId}/attachments/m-1`)) {
      if (plan.message === 403) {
        return jsonRes({ code: 'forbidden', message: 'No tienes acceso' }, 403)
      }
      if (plan.message === 404) {
        return jsonRes(
          {
            code: plan.messageCode ?? 'attachment_file_not_found',
            message: 'No hay archivo',
          },
          404,
        )
      }
      return bytesRes('image/png', 'inline; filename="comprobante.png"')
    }
    if (url.includes(`/api/tickets/${ticketId}/attachments/m-1`) && url.includes('download=1')) {
      if (plan.download === 403) {
        return jsonRes({ code: 'forbidden', message: 'No tienes acceso' }, 403)
      }
      return bytesRes('image/png', 'attachment; filename="comprobante.png"')
    }
    if (url.endsWith(`/api/tickets/${ticketId}/attachments`)) {
      if (plan.attachments === 403) {
        return jsonRes({ code: 'forbidden', message: 'Sin acceso' }, 403)
      }
      return jsonRes({ data: plan.attachmentRows ?? [attachmentFixture] })
    }
    if (url.endsWith(`/api/tickets/${ticketId}/messages`)) {
      return jsonRes({ data: [messageFixture] })
    }
    if (url.endsWith(`/api/tickets/${ticketId}/conversations`)) {
      return jsonRes({ data: [] })
    }
    if (url.endsWith(`/api/tickets/${ticketId}/context`)) {
      return jsonRes({ data: null })
    }
    if (url.endsWith(`/api/tickets/${ticketId}`)) {
      // The plan describes the ticket under test (t-1); the second ticket
      // (t-2) is the one the operator moves to after losing access.
      if (plan.ticket === 403 && ticketId === 't-1') {
        return jsonRes({ code: 'forbidden', message: 'No tienes acceso' }, 403)
      }
      return jsonRes({ data: ticket })
    }
    if (url.endsWith('/api/users/assignable')) return jsonRes({ data: [] })
    if (url.endsWith('/api/themes')) return jsonRes({ data: [] })
    return jsonRes({ code: 'not_found', message: `Unexpected ${url}` }, 404)
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
}

const objectUrl = 'blob:mock-url'

beforeEach(() => {
  cleanup()
  currentTicketId = 't-1'
  // `vi.restoreAllMocks()` in afterEach clears the implementation of the
  // mocked session too, so it is armed again here.
  vi.mocked(getSession).mockResolvedValue({
    access_token: 'token-test',
  } as unknown as Session)
  installFetch()
  globalThis.URL.createObjectURL = vi.fn(() => objectUrl)
  globalThis.URL.revokeObjectURL = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

async function renderLoaded() {
  render(<TicketDetailPage />)
  // The evidence row is the last thing to arrive; waiting for it means the
  // list is really on screen before the test touches it.
  await waitFor(() =>
    expect(screen.getByText('Hola, ¿me mandas el comprobante?')).toBeTruthy(),
  )
}

describe('TicketDetailPage — vista previa y descarga', () => {
  it('ofrece vista previa y descarga para cada adjunto listado', async () => {
    await renderLoaded()

    expect(screen.getByText('Hola, ¿me mandas el comprobante?')).toBeTruthy()
    expect(
      screen.getByRole('button', { name: /ver el archivo adjunto 1/i }),
    ).toBeTruthy()
    expect(
      screen.getByRole('button', { name: /descargar el archivo adjunto 1/i }),
    ).toBeTruthy()
  })

  it('pide los bytes a la API con el token y los muestra con un object URL', async () => {
    await renderLoaded()

    fireEvent.click(screen.getByRole('button', { name: /ver el archivo adjunto 1/i }))

    const image = await waitFor(() => screen.getByRole('img'))
    expect((image as HTMLImageElement).getAttribute('src')).toBe(objectUrl)
    expect(globalThis.URL.createObjectURL).toHaveBeenCalled()

    const call = fetchMock.mock.calls.find((c) =>
      String(c[0]).endsWith('/api/tickets/t-1/attachments/m-1'),
    )
    expect(call).toBeTruthy()
    const headers = call?.[1]?.headers as unknown as Record<string, string>
    expect(headers.Authorization).toBe('Bearer token-test')
  })

  it('la descarga pide los bytes con download=1 y entrega el archivo con su nombre', async () => {
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {})

    await renderLoaded()

    fireEvent.click(
      screen.getByRole('button', { name: /descargar el archivo adjunto 1/i }),
    )

    await waitFor(() => expect(clickSpy).toHaveBeenCalled())
    const call = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('/api/tickets/t-1/attachments/m-1'),
    )
    expect(String(call?.[0])).toContain('download=1')

    const anchor = clickSpy.mock.instances[0] as unknown as HTMLAnchorElement
    expect(anchor.download).toBe('comprobante.png')
  })
})

describe('TicketDetailPage — 403 (ya no puedes ver esto)', () => {
  it('un 403 al abrir un adjunto retira la fila y sus controles', async () => {
    installFetch({ message: 403 })
    await renderLoaded()

    fireEvent.click(screen.getByRole('button', { name: /ver el archivo adjunto 1/i }))

    await waitFor(() =>
      expect(screen.queryByText('Hola, ¿me mandas el comprobante?')).toBeNull(),
    )
    expect(
      screen.queryByRole('button', { name: /descargar el archivo adjunto/i }),
    ).toBeNull()
    expect(screen.getByText(/ya no está disponible/i)).toBeTruthy()
  })

  it('un 403 al descargar revoca la vista previa y retira la fila', async () => {
    installFetch({ download: 403 })
    await renderLoaded()

    fireEvent.click(screen.getByRole('button', { name: /ver el archivo adjunto 1/i }))
    await waitFor(() => expect(screen.getByRole('img')).toBeTruthy())

    fireEvent.click(
      screen.getByRole('button', { name: /descargar el archivo adjunto 1/i }),
    )

    await waitFor(() =>
      expect(screen.queryByText('Hola, ¿me mandas el comprobante?')).toBeNull(),
    )
    expect(globalThis.URL.revokeObjectURL).toHaveBeenCalledWith(objectUrl)
  })

  it('un 404 en el listado de adjuntos vacía la lista de evidencia', async () => {
    installFetch({ attachments: 403 })

    render(<TicketDetailPage />)

    await waitFor(() =>
      expect(screen.getByText(/ya no puedes ver los adjuntos/i)).toBeTruthy(),
    )
    expect(screen.queryByText('Hola, ¿me mandas el comprobante?')).toBeNull()
  })

  it('un 404 al abrir un adjunto dice que el mensaje no trae archivo y deja la fila', async () => {
    installFetch({ message: 404 })

    await renderLoaded()

    fireEvent.click(screen.getByRole('button', { name: /ver el archivo adjunto 1/i }))

    await waitFor(() =>
      expect(screen.getByText(/no tiene un archivo adjunto/i)).toBeTruthy(),
    )
    // The row is still valid evidence: only the file is missing.
    expect(screen.getByText('Hola, ¿me mandas el comprobante?')).toBeTruthy()
  })

  it('un 404 de adjunto desvinculado retira la fila', async () => {
    installFetch({ message: 404, messageCode: 'attachment_not_found' })

    await renderLoaded()

    fireEvent.click(screen.getByRole('button', { name: /ver el archivo adjunto 1/i }))

    await waitFor(() =>
      expect(screen.queryByText('Hola, ¿me mandas el comprobante?')).toBeNull(),
    )
  })

  it('una fila sin archivo no ofrece vista previa ni descarga', async () => {
    installFetch({ attachmentRows: [textOnlyAttachmentFixture] })

    render(<TicketDetailPage />)

    await waitFor(() => expect(screen.getByText('Texto sin archivo')).toBeTruthy())
    expect(
      screen.queryByRole('button', { name: /ver el archivo adjunto/i }),
    ).toBeNull()
    expect(
      screen.queryByRole('button', { name: /descargar el archivo adjunto/i }),
    ).toBeNull()
  })

  it('un 403 al cargar el ticket retira el historial cacheado', async () => {
    installFetch({ ticket: 403 })

    render(<TicketDetailPage />)

    await waitFor(() =>
      expect(screen.getByText(/ya no tienes acceso a este ticket/i)).toBeTruthy(),
    )
    expect(screen.queryByText('Comprobante de pago')).toBeNull()
    expect(screen.queryByText('Mensaje interno del ticket')).toBeNull()
  })

  it('un 403 en un ticket no impide abrir otro ticket', async () => {
    installFetch({ ticket: 403 })

    const view = render(<TicketDetailPage />)
    await waitFor(() =>
      expect(screen.getByText(/ya no tienes acceso a este ticket/i)).toBeTruthy(),
    )

    currentTicketId = 't-2'
    view.rerender(<TicketDetailPage />)

    await waitFor(() => expect(screen.getByText('Otro ticket')).toBeTruthy())
    expect(screen.queryByText(/ya no tienes acceso a este ticket/i)).toBeNull()
  })
})
