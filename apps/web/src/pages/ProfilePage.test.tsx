import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import ProfilePage from './ProfilePage'

/**
 * El perfil se resuelve asíncrono (/api/me). Mientras llega, la persona
 * puede escribir. Cuando llegaba, la página rellenaba los campos y **borraba
 * lo que se había escrito**: el guardado persistía el nombre viejo y la
 * interfaz decía "Perfil guardado".
 *
 * Estos casos fijan esa regla: el perfil siembra los campos si y solo si la
 * persona todavía no los tocó.
 */

vi.mock('@/lib/api', () => ({
  api: { patch: vi.fn().mockResolvedValue({ data: {} }) },
  ApiError: class ApiError extends Error {},
}))

interface FakeProfile {
  display_name: string | null
  phone: string | null
}

const store = {
  profile: null as FakeProfile | null,
  user: { email: 'e2e@example.test' } as { email: string } | null,
  refreshProfile: vi.fn().mockResolvedValue(undefined),
}

vi.mock('@/stores/auth', () => ({
  useAuthStore: (selector: (s: typeof store) => unknown) => selector(store),
}))

function valueOf(label: string): string {
  return (screen.getByLabelText(label) as HTMLInputElement).value
}

beforeEach(() => {
  cleanup()
  store.profile = null
  store.user = { email: 'e2e@example.test' }
  store.refreshProfile.mockClear()
})

describe('ProfilePage — siembra de los campos', () => {
  it('siembra el nombre cuando el perfil llega antes de que se escriba', () => {
    store.profile = { display_name: 'E2E Administrador', phone: '+52 555 000 0000' }
    render(<ProfilePage />)
    expect(valueOf('Nombre')).toBe('E2E Administrador')
    expect(valueOf('Teléfono')).toBe('+52 555 000 0000')
  })

  it('NO borra lo escrito mientras el perfil llega', () => {
    const { rerender } = render(<ProfilePage />)
    // La persona escribe antes de que /api/me responda.
    fireEvent.change(screen.getByLabelText('Nombre'), { target: { value: 'Nombre E2E' } })
    // Ahora llega el perfil con el nombre viejo.
    store.profile = { display_name: 'E2E Administrador', phone: null }
    rerender(<ProfilePage />)

    expect(valueOf('Nombre')).toBe('Nombre E2E')
  })

  it('NO borra lo escrito en el teléfono mientras el perfil llega', () => {
    const { rerender } = render(<ProfilePage />)
    fireEvent.change(screen.getByLabelText('Teléfono'), { target: { value: '+52 555 999 0000' } })
    store.profile = { display_name: 'E2E Administrador', phone: '+52 555 000 0000' }
    rerender(<ProfilePage />)

    expect(valueOf('Teléfono')).toBe('+52 555 999 0000')
  })
})
