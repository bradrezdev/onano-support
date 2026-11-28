/**
 * The message draft store (browser side).
 *
 * WHY THIS EXISTS
 * A WhatsApp draft is private to the person writing it. Two isolations have
 * to hold at the same time:
 *
 *   1. Per agent — the browser is shared. The operator on the same machine
 *      (a support desk with one workstation, a kiosk, a family laptop) must
 *      not read somebody else's half-written answer.
 *   2. Per chat — the draft of one client must never appear in another
 *      client's conversation. Answering "te paso el comprobante" under
 *      somebody else's thread is the kind of mistake that leaks evidence.
 *
 * KEY FORMAT
 * `crm:draft:<agentId>:<conversationId>`
 *
 * The agent id comes from the resolved profile (`/api/me`), never from the
 * browser: an id that the client can pick would be an id that the client can
 * lie about. The conversation id is the chat the draft belongs to.
 *
 * The store is deliberately pure: it takes the storage as an argument so the
 * rules can be tested without a browser, and every access is guarded — a
 * browser in private mode or with a full quota must not break the composer.
 */

/** Namespace for every draft key. */
export const DRAFT_KEY_PREFIX = 'crm:draft:'

/** The subset of the Storage API this module needs. */
export interface DraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * The storage key for a (agent, conversation) pair.
 *
 * `crm:draft:<agentId>:<conversationId>` — both ids are part of the key, so
 * a lookup for one pair can never hit the entry of another.
 */
export function draftKey(agentId: string, conversationId: string): string {
  return `${DRAFT_KEY_PREFIX}${agentId}:${conversationId}`
}

/**
 * The real localStorage, or null when the browser has none (server-side
 * render, private mode with storage disabled, a locked-down kiosk).
 */
function defaultStorage(): DraftStorage | null {
  try {
    if (typeof globalThis.localStorage === 'undefined') return null
    return globalThis.localStorage
  } catch {
    // Accessing localStorage throws when cookies/storage are blocked.
    return null
  }
}

function resolveStorage(storage?: DraftStorage | null): DraftStorage | null {
  if (storage) return storage
  return defaultStorage()
}

/** The stored draft for a pair, or '' when there is none. */
export function readDraft(
  agentId: string,
  conversationId: string,
  storage?: DraftStorage | null,
): string {
  const store = resolveStorage(storage)
  if (!store) return ''
  try {
    return store.getItem(draftKey(agentId, conversationId)) ?? ''
  } catch {
    return ''
  }
}

/**
 * Stores the draft. A blank text removes the entry instead of leaving an
 * empty string behind: an empty draft is the absence of a draft.
 */
export function writeDraft(
  agentId: string,
  conversationId: string,
  text: string,
  storage?: DraftStorage | null,
): void {
  const store = resolveStorage(storage)
  if (!store) return
  const key = draftKey(agentId, conversationId)
  try {
    if (text.trim() === '') {
      store.removeItem(key)
      return
    }
    store.setItem(key, text)
  } catch {
    // Quota exceeded or storage disabled: the draft simply does not survive
    // a reload. Losing persistence must never break the composer.
  }
}

/** Forgets the draft of a pair (sent, or access lost). */
export function clearDraft(
  agentId: string,
  conversationId: string,
  storage?: DraftStorage | null,
): void {
  const store = resolveStorage(storage)
  if (!store) return
  try {
    store.removeItem(draftKey(agentId, conversationId))
  } catch {
    // Nothing to do: there is no entry we could remove anyway.
  }
}
