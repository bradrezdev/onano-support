import { NextResponse } from 'next/server'
import type { ZodError, ZodType } from 'zod'

/**
 * Parse a request body as JSON and validate against a Zod schema.
 * Returns either the parsed data or a 400 NextResponse.
 */
export async function parseJson<S extends ZodType>(
  request: Request,
  schema: S,
): Promise<{ data: ReturnType<S['parse']> } | { error: NextResponse }> {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return {
      error: NextResponse.json(
        {
          code: 'invalid_json',
          error: 'invalid_json',
          message: 'Request body is not valid JSON',
        },
        { status: 400 },
      ),
    }
  }
  const result = schema.safeParse(raw)
  if (!result.success) {
    return {
      error: NextResponse.json(
        {
          code: 'validation_failed',
          error: 'validation_failed',
          message: 'Validation failed',
          details: flattenZodError(result.error),
        },
        { status: 400 },
      ),
    }
  }
  return { data: result.data as ReturnType<S['parse']> }
}

function flattenZodError(err: ZodError): Array<{ path: string; message: string }> {
  return err.issues.map((i) => ({
    path: i.path.join('.'),
    message: i.message,
  }))
}

/**
 * Parse query params (URLSearchParams) into a plain object, coercing
 * numbers and booleans when asked. Used by list endpoints.
 */
export function getQuery<T extends Record<string, unknown>>(
  request: Request,
  parsers: Partial<Record<keyof T, (v: string) => unknown>> = {},
): T {
  const url = new URL(request.url)
  const out: Record<string, unknown> = {}
  for (const [k, v] of url.searchParams.entries()) {
    if (k in parsers) {
      const parser = parsers[k as keyof T]
      if (parser) {
        out[k] = parser(v)
        continue
      }
    }
    out[k] = v
  }
  return out as T
}