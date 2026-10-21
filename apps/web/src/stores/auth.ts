import { create } from 'zustand'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import { API_BASE_URL } from '@/lib/api'
import type { Role, Permission } from '@/lib/permissions'

export interface Profile {
  id: string
  display_name: string | null
  /** Self-set contact number from the profile page. */
  phone: string | null
  /** Legacy role, still one of the three shipped slugs. */
  role: Role
  /** Source of truth: the slug of the role in public.roles (R2). */
  role_key: string
  /** Resolved keyring from /api/me. Authoritative for what the user may do. */
  permissions: Permission[]
  avatar_url: string | null
  suspended_at?: string | null
  deleted_at?: string | null
}

interface AuthState {
  initialized: boolean
  loading: boolean
  session: Session | null
  user: User | null
  profile: Profile | null

  hydrate: () => Promise<void>
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string, displayName?: string) => Promise<void>
  signOut: () => Promise<void>
  refreshProfile: () => Promise<void>
}

export const useAuthStore = create<AuthState>((set, get) => ({
  initialized: false,
  loading: false,
  session: null,
  user: null,
  profile: null,

  async hydrate() {
    if (get().initialized) return
    set({ loading: true })

    const { data } = await supabase.auth.getSession()
    set({
      session: data.session,
      user: data.session?.user ?? null,
      loading: false,
    })

    if (data.session?.user) {
      await get().refreshProfile()
    }

    supabase.auth.onAuthStateChange(async (_event, session) => {
      set({ session, user: session?.user ?? null })
      if (session?.user) {
        await get().refreshProfile()
      } else {
        set({ profile: null })
      }
    })

    set({ initialized: true })
  },

  async signIn(email, password) {
    set({ loading: true })
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      set({ loading: false })
      throw error
    }
    set({ loading: false })
  },

  async signUp(email, password, displayName) {
    set({ loading: true })
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: displayName ? { data: { display_name: displayName } } : undefined,
    })
    if (error) {
      set({ loading: false })
      throw error
    }
    set({ loading: false })
  },

  async signOut() {
    await supabase.auth.signOut()
    set({ session: null, user: null, profile: null })
  },

  /**
   * Loads the signed-in user's profile + resolved permission keyring.
   *
   * Reads /api/me rather than the profiles table with the anon Supabase
   * client: permissions live in role_permissions, so the table alone cannot
   * answer "what may this person do". The API is the single source.
   *
   * If the call fails (offline, API down) the previous profile is kept —
   * better to render stale permissions than to log the user out mid-task.
   */
  async refreshProfile() {
    const user = get().user
    if (!user) return

    const session = get().session
    if (!session?.access_token) return

    try {
      const res = await fetch(`${API_BASE_URL}/api/me`, {
        headers: { authorization: `Bearer ${session.access_token}` },
      })
      if (!res.ok) return
      const body = (await res.json()) as { data: Profile }
      set({ profile: body.data })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[auth] refreshProfile failed', err)
    }
  },
}))