import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { listAssignableAgents } from '@/services/users'

/**
 * GET /api/users/assignable — minimal agent list for assignee pickers.
 *
 * R1 keeps the full account list behind `admin.viewAccounts`, but a ticket or
 * conversation cannot be assigned without knowing who exists. This endpoint
 * returns only { id, display_name, role_key } for accounts that can take work
 * — no email, no suspension state, no sign-in metadata.
 *
 * `conversation.read` is the gate: anyone who can open the inbox can offer
 * conversations, so anyone who can open the inbox can see the roster.
 */
export async function GET(request: Request) {
  const auth = await requireUser(request)
  if ('error' in auth) return auth.error

  return NextResponse.json({ data: await listAssignableAgents() })
}