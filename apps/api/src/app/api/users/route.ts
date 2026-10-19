import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getQuery } from '@/lib/validate'
import { listUsers, searchUsers } from '@/services/users'

export async function GET(request: Request) {
  const auth = await requireRole(['admin', 'supervisor'], request)
  if ('error' in auth) return auth.error

  const q = getQuery<{ q?: string }>(request, {
    q: (v) => v,
  })

  if (q.q && q.q.trim()) {
    const users = await searchUsers(q.q)
    return NextResponse.json({ data: users })
  }
  const users = await listUsers()
  return NextResponse.json({ data: users })
}