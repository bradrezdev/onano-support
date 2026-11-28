import { describe, it, expect } from 'vitest'
import {
  DRAFT_KEY_PREFIX,
  clearDraft,
  draftKey,
  readDraft,
  writeDraft,
} from './drafts'

/**
 * The draft store is the browser-side half of S12: the message draft lives
 * under a key that carries BOTH the acting agent and the conversation, so
 * opening another client's chat (or signing in as another agent on the same
 * machine) never shows a text that belongs to somebody else.
 *
 * These cases pin the key format, the round trip and the two isolations.
 */

/** An in-memory Storage so the tests never touch the real one. */
function fakeStorage(): Storage {
  const map = new Map<string, string>()
  return {
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
}

describe('draft store — formato de la clave', () => {
  it('usa crm:draft:<agentId>:<conversationId>', () => {
    expect(DRAFT_KEY_PREFIX).toBe('crm:draft:')
    expect(draftKey('agent-1', 'conv-1')).toBe('crm:draft:agent-1:conv-1')
  })
})

describe('draft store — ida y vuelta', () => {
  it('guarda y devuelve el texto', () => {
    const storage = fakeStorage()
    writeDraft('agent-1', 'conv-1', 'Hola, ya voy', storage)
    expect(readDraft('agent-1', 'conv-1', storage)).toBe('Hola, ya voy')
  })

  it('devuelve vacío cuando no hay nada guardado', () => {
    expect(readDraft('agent-1', 'conv-1', fakeStorage())).toBe('')
  })

  it('borra el borrador', () => {
    const storage = fakeStorage()
    writeDraft('agent-1', 'conv-1', 'texto', storage)
    clearDraft('agent-1', 'conv-1', storage)
    expect(readDraft('agent-1', 'conv-1', storage)).toBe('')
    expect(storage.getItem('crm:draft:agent-1:conv-1')).toBeNull()
  })

  it('un texto vacío quita la clave en vez de guardar una cadena vacía', () => {
    const storage = fakeStorage()
    writeDraft('agent-1', 'conv-1', 'texto', storage)
    writeDraft('agent-1', 'conv-1', '   ', storage)
    expect(storage.getItem('crm:draft:agent-1:conv-1')).toBeNull()
  })
})

describe('draft store — aislamiento', () => {
  it('otro agente no ve el borrador del mismo chat', () => {
    const storage = fakeStorage()
    writeDraft('agent-1', 'conv-1', 'privado de agent-1', storage)
    expect(readDraft('agent-2', 'conv-1', storage)).toBe('')
  })

  it('otro chat no ve el borrador del chat anterior', () => {
    const storage = fakeStorage()
    writeDraft('agent-1', 'conv-1', 'privado de conv-1', storage)
    expect(readDraft('agent-1', 'conv-2', storage)).toBe('')
  })
})

describe('draft store — almacenamiento defectuoso', () => {
  it('no propaga el error cuando el almacenamiento falla', () => {
    const broken: Storage = {
      getItem: () => {
        throw new Error('boom')
      },
      setItem: () => {
        throw new Error('boom')
      },
      removeItem: () => {
        throw new Error('boom')
      },
      clear: () => {},
      key: () => null,
      get length() {
        return 0
      },
    } as Storage

    expect(() => writeDraft('agent-1', 'conv-1', 'texto', broken)).not.toThrow()
    expect(() => clearDraft('agent-1', 'conv-1', broken)).not.toThrow()
    expect(readDraft('agent-1', 'conv-1', broken)).toBe('')
  })
})

describe('draft store — el almacenamiento del navegador', () => {
  /**
   * The page uses the default storage (no argument). These cases pin that
   * path: the browser's localStorage when there is one, and a composer that
   * does not break when there is none (a locked-down kiosk, a private window
   * with storage disabled, a server-side render).
   */
  it('usa el localStorage del navegador cuando no se le pasa uno', () => {
    const map = new Map<string, string>()
    const stub = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v)
      },
      removeItem: (k: string) => {
        map.delete(k)
      },
    }
    Object.defineProperty(globalThis, 'localStorage', {
      value: stub,
      configurable: true,
      writable: true,
    })

    writeDraft('agent-1', 'conv-1', 'texto')

    expect(readDraft('agent-1', 'conv-1')).toBe('texto')
    expect(map.get('crm:draft:agent-1:conv-1')).toBe('texto')
  })

  it('sin almacenamiento el compositor no se rompe', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: undefined,
      configurable: true,
      writable: true,
    })

    expect(() => writeDraft('agent-1', 'conv-1', 'texto')).not.toThrow()
    expect(readDraft('agent-1', 'conv-1')).toBe('')
  })
})
