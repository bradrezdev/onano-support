/**
 * Loads role color settings from /api/role-colors and applies them as CSS
 * custom properties on :root so bubbles can use `var(--role-admin)` etc.
 * Hot-reloads: admin can change a color and the next load picks it up without
 * rebuilding the bundle.
 */

import { api } from './api'
import type { Role } from './permissions'

export interface RoleColorSetting {
  role: Role
  base_color: string
  fade_steps: number
}

const VAR_BY_ROLE: Record<Role, string> = {
  admin: '--role-admin',
  supervisor: '--role-supervisor',
  soporte: '--role-soporte',
}

let cached: RoleColorSetting[] | null = null

function applyToRoot(settings: RoleColorSetting[]): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  for (const s of settings) {
    const cssVar = VAR_BY_ROLE[s.role]
    if (cssVar) root.style.setProperty(cssVar, s.base_color)
  }
}

export async function loadRoleColors(force = false): Promise<RoleColorSetting[]> {
  if (!force && cached) {
    applyToRoot(cached)
    return cached
  }
  try {
    const res = await api.get<{ data: RoleColorSetting[] }>('/api/role-colors')
    cached = res.data
    applyToRoot(cached)
    return cached
  } catch (err) {
    // Fall back to whatever CSS vars are already set in index.css.
    // eslint-disable-next-line no-console
    console.warn('[roleColors] fetch failed, using defaults', err)
    return []
  }
}

/**
 * Inline style for a bubble given its author role + fade_step.
 * fade_step=0 uses the full role color; each subsequent step mixes with white
 * to fade toward the background. Uses color-mix so the admin's runtime hex
 * edit propagates without restyling.
 */
export function bubbleStyle(role: Role, fadeStep: number): React.CSSProperties {
  const cssVar = VAR_BY_ROLE[role]
  // 0% white = full role color; each +step adds 12% white, capped at 88%
  const whitePct = Math.min(fadeStep * 12, 88)
  return {
    backgroundColor: `color-mix(in oklab, var(${cssVar}), white ${whitePct}%)`,
    borderColor: `color-mix(in oklab, var(${cssVar}), white ${Math.max(whitePct - 20, 0)}%)`,
  }
}