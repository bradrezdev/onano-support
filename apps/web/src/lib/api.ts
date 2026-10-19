/**
 * Typed fetch wrapper for the Next.js backend at apps/api.
 * Reads the Supabase session JWT from the browser supabase-js client and
 * injects it as `Authorization: Bearer <jwt>` on every request.
 */

import { getSession } from './supabase'

export class ApiError extends Error {
  status: number
  code: string
  details?: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

const BASE = (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')

async function authHeader(): Promise<Record<string, string>> {
  const session = await getSession()
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const url = path.startsWith('http') ? path : `${BASE}${path}`
  const { json, headers, ...rest } = init
  const auth = await authHeader()
  const finalHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...auth,
    ...(headers as Record<string, string> | undefined),
  }

  const res = await fetch(url, {
    ...rest,
    headers: finalHeaders,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  })

  if (!res.ok) {
    type ErrorBody = { code?: string; message?: string; details?: unknown }
    let body: ErrorBody | null = null
    try {
      body = (await res.json()) as ErrorBody
    } catch {
      // ignore parse errors
    }
    throw new ApiError(
      res.status,
      body?.code ?? 'unknown',
      body?.message ?? `HTTP ${res.status}`,
      body?.details,
    )
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export const api = {
  get: <T>(path: string) => apiFetch<T>(path),
  post: <T>(path: string, json?: unknown) => apiFetch<T>(path, { method: 'POST', json }),
  patch: <T>(path: string, json?: unknown) => apiFetch<T>(path, { method: 'PATCH', json }),
  del: <T>(path: string) => apiFetch<T>(path, { method: 'DELETE' }),
}