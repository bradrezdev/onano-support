import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

/**
 * Per-route CORS middleware for the API. The web SPA runs on
 * `http://localhost:5173` (Vite dev) or a separate origin in prod; this
 * middleware sets Access-Control-Allow-* on every `/api/*` response so
 * cross-origin fetch from the SPA does not throw "Load failed".
 *
 * Permissive defaults for dev. Prod: tighten via CORS_ORIGINS env.
 */

function allowedOrigin(req: NextRequest): string {
  const reqOrigin = req.headers.get('origin')
  const configured = process.env.CORS_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean) ?? []
  // Dev origins: anything on localhost (5173, 4173, 3000).
  const isDevLocal = reqOrigin && /^https?:\/\/localhost(:\d+)?$/.test(reqOrigin)
  if (configured.includes(reqOrigin ?? '')) return reqOrigin ?? '*'
  if (isDevLocal) return reqOrigin ?? '*'
  return configured[0] ?? '*'
}

export function middleware(request: NextRequest) {
  const origin = allowedOrigin(request)
  // For preflight: respond directly with the allow-* headers and 204.
  if (request.method === 'OPTIONS') {
    return new NextResponse(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, content-type, x-twilio-signature',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      },
    })
  }

  // For real requests: forward through, then add CORS headers to the response.
  const res = NextResponse.next()
  res.headers.set('Access-Control-Allow-Origin', origin)
  res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS')
  res.headers.set('Access-Control-Allow-Headers', 'authorization, content-type, x-twilio-signature')
  res.headers.set('Access-Control-Allow-Credentials', 'true')
  res.headers.set('Vary', 'Origin')
  return res
}

export const config = {
  matcher: '/api/:path*',
}
