import { create } from 'zustand'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import type { Role } from '@/lib/permissions'

export interface Profile {
  id: string
  display_name: string | null
  role: Role
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

  async refreshProfile() {
    const user = get().user
    if (!user) return
    const { data, error } = await supabase
      .from('profiles')
      .select('id, display_name, role, avatar_url, suspended_at, deleted_at')
      .eq('id', user.id)
      .maybeSingle()
    if (error) {
      // RLS may deny the read for anon key — backend will fetch on first API call.
      // eslint-disable-next-line no-console
      console.warn('[auth] refreshProfile failed', error)
      return
    }
    if (!data) return
    set({ profile: data as Profile })
  },
}))