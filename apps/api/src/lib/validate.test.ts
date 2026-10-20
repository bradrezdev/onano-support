import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { parseJson, getQuery } from './validate'

describe('parseJson', () => {
  const schema = z.object({
    name: z.string().min(2),
    age: z.number().int().positive(),
  })

  it('returns parsed data when body matches schema', async () => {
    const req = new Request('http://x/api', {
      method: 'POST',
      body: JSON.stringify({ name: 'Bryan', age: 33 }),
      headers: { 'content-type': 'application/json' },
    })
    const result = await parseJson(req, schema)
    expect('data' in result).toBe(true)
    if ('data' in result) {
      expect(result.data).toEqual({ name: 'Bryan', age: 33 })
    }
  })

  it('returns 400 invalid_json when body is not parseable', async () => {
    const req = new Request('http://x/api', {
      method: 'POST',
      body: 'this is not json',
    })
    const result = await parseJson(req, schema)
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error.status).toBe(400)
      const body = (await result.error.json()) as { code: string; error: string }
      expect(body.code).toBe('invalid_json')
      expect(body.error).toBe('invalid_json')
    }
  })

  it('returns 400 validation_failed with field details when schema rejects', async () => {
    const req = new Request('http://x/api', {
      method: 'POST',
      body: JSON.stringify({ name: 'B', age: -3 }),
      headers: { 'content-type': 'application/json' },
    })
    const result = await parseJson(req, schema)
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error.status).toBe(400)
      const body = (await result.error.json()) as {
        code: string
        details: Array<{ path: string; message: string }>
      }
      expect(body.code).toBe('validation_failed')
      expect(body.details.length).toBeGreaterThan(0)
      expect(body.details.map((d) => d.path)).toContain('name')
      expect(body.details.map((d) => d.path)).toContain('age')
    }
  })

  it('rejects extra fields via passthrough = false (default Zod behavior)', async () => {
    const strict = z.object({ name: z.string() }).strict()
    const req = new Request('http://x/api', {
      method: 'POST',
      body: JSON.stringify({ name: 'ok', extra: 'nope' }),
      headers: { 'content-type': 'application/json' },
    })
    const result = await parseJson(req, strict)
    expect('error' in result).toBe(true)
  })

  it('returns data for arrays when schema is z.array(...)', async () => {
    const arrSchema = z.array(z.object({ id: z.string() }))
    const req = new Request('http://x/api', {
      method: 'POST',
      body: JSON.stringify([{ id: 'a' }, { id: 'b' }]),
      headers: { 'content-type': 'application/json' },
    })
    const result = await parseJson(req, arrSchema)
    expect('data' in result).toBe(true)
    if ('data' in result) {
      expect(result.data).toEqual([{ id: 'a' }, { id: 'b' }])
    }
  })
})

describe('getQuery', () => {
  it('returns plain key/value pairs when no parsers supplied', () => {
    const req = new Request('http://x/api?a=1&b=two')
    const out = getQuery<{ a: string; b: string }>(req)
    expect(out).toEqual({ a: '1', b: 'two' })
  })

  it('coerces values using supplied parsers', () => {
    const req = new Request('http://x/api?limit=20&active=true')
    const out = getQuery<{ limit: number; active: boolean }>(req, {
      limit: (v) => Number(v),
      active: (v) => v === 'true',
    })
    expect(out).toEqual({ limit: 20, active: true })
  })

  it('ignores parser when key is absent (no spurious entries)', () => {
    const req = new Request('http://x/api?foo=bar')
    const out = getQuery<{ foo: string; limit: number }>(req, {
      limit: (v) => Number(v),
    })
    expect(out).toEqual({ foo: 'bar' })
    expect('limit' in out).toBe(false)
  })

  it('coerces empty string to NaN/0/false per parser — caller decides', () => {
    const req = new Request('http://x/api?limit=')
    const out = getQuery<{ limit: number }>(req, { limit: (v) => Number(v) })
    expect(out.limit).toBe(0) // Number('') === 0
  })

  it('multiple values for the same key: last one wins (per URLSearchParams semantics)', () => {
    const req = new Request('http://x/api?tag=a&tag=b')
    const out = getQuery<{ tag: string }>(req)
    expect(out.tag).toBe('b')
  })
})
