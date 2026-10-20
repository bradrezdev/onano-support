import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Supabase query mock.
// ---------------------------------------------------------------------------

type Response = { data: unknown; error?: unknown; count?: number | null }
type Op = { op: string; args: unknown[] }

class QueryMock {
  ops: Op[] = []
  payload: Response = { data: null, error: null }

  private record(op: string, args: unknown[]): this {
    this.ops.push({ op, args })
    return this
  }
  select(...args: unknown[]) { return this.record('select', args) }
  eq(col: string, val: unknown) { return this.record('eq', [col, val]) }
  order(col: string, opts?: unknown) { return this.record('order', [col, opts]) }
  maybeSingle(): Promise<Response> { return Promise.resolve(this.payload) }
  single(): Promise<Response> { return Promise.resolve(this.payload) }
  then<T>(onFulfilled: (v: Response) => T): Promise<T> {
    return Promise.resolve(this.payload).then(onFulfilled)
  }
}

const mockAdmin: any = {
  from: vi.fn((): QueryMock => new QueryMock()),
}

vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: () => mockAdmin,
}))

const cats = await import('./categories')

beforeEach(() => {
  mockAdmin.from.mockReset()
})

function makeCat(id: string, parent_id: string | null, name: string) {
  return {
    id,
    parent_id,
    name,
    description: null,
    created_by: 'u-1',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }
}

describe('listCategoryTree', () => {
  it('returns [] when there are no rows', async () => {
    const q = new QueryMock()
    q.payload = { data: [], error: null }
    mockAdmin.from.mockReturnValueOnce(q)
    const out = await cats.listCategoryTree()
    expect(out).toEqual([])
  })

  it('returns a flat list of top-level categories when there are no children', async () => {
    const q = new QueryMock()
    q.payload = {
      data: [
        makeCat('a', null, 'Billing'),
        makeCat('b', null, 'Support'),
      ],
      error: null,
    }
    mockAdmin.from.mockReturnValueOnce(q)
    const out = await cats.listCategoryTree()
    expect(out.length).toBe(2)
    expect(out.map((c) => c.name).sort()).toEqual(['Billing', 'Support'])
    expect(out[0]!.children).toEqual([])
    expect(out[1]!.children).toEqual([])
  })

  it('nests children under their parents', async () => {
    const q = new QueryMock()
    q.payload = {
      data: [
        makeCat('a', null, 'Billing'),
        makeCat('a1', 'a', 'Refunds'),
        makeCat('a2', 'a', 'Invoices'),
        makeCat('b', null, 'Support'),
        makeCat('b1', 'b', 'Login'),
      ],
      error: null,
    }
    mockAdmin.from.mockReturnValueOnce(q)
    const out = await cats.listCategoryTree()
    const billing = out.find((c) => c.id === 'a')
    expect(billing).toBeDefined()
    expect(billing!.children.map((c) => c.name).sort()).toEqual(['Invoices', 'Refunds'])
    const refunds = billing!.children.find((c) => c.id === 'a1')!
    expect(refunds.children).toEqual([])
  })

  it('recurses into grand-children', async () => {
    const q = new QueryMock()
    q.payload = {
      data: [
        makeCat('a', null, 'Root'),
        makeCat('b', 'a', 'Mid'),
        makeCat('c', 'b', 'Leaf'),
      ],
      error: null,
    }
    mockAdmin.from.mockReturnValueOnce(q)
    const out = await cats.listCategoryTree()
    expect(out[0]!.children[0]!.children[0]!.name).toBe('Leaf')
  })

  it('returns [] when payload is null (defensive)', async () => {
    const q = new QueryMock()
    q.payload = { data: null, error: null }
    mockAdmin.from.mockReturnValueOnce(q)
    const out = await cats.listCategoryTree()
    expect(out).toEqual([])
  })

  it('throws on Supabase error', async () => {
    const q = new QueryMock()
    q.payload = { data: null, error: { message: 'rls' } }
    mockAdmin.from.mockReturnValueOnce(q)
    await expect(cats.listCategoryTree()).rejects.toBeDefined()
  })
})

describe('findCategoryById', () => {
  it('returns the category row when found', async () => {
    const q = new QueryMock()
    q.payload = { data: makeCat('a', null, 'Billing'), error: null }
    mockAdmin.from.mockReturnValueOnce(q)
    const out = await cats.findCategoryById('a')
    expect(out?.id).toBe('a')
  })

  it('returns null when not found', async () => {
    const q = new QueryMock()
    q.payload = { data: null, error: null }
    mockAdmin.from.mockReturnValueOnce(q)
    const out = await cats.findCategoryById('missing')
    expect(out).toBeNull()
  })
})

describe('categoryHasChildren', () => {
  it('returns true when count > 0', async () => {
    const q = new QueryMock()
    q.payload = { data: null, error: null, count: 3 }
    mockAdmin.from.mockReturnValueOnce(q)
    expect(await cats.categoryHasChildren('a')).toBe(true)
  })

  it('returns false when count is 0 or null', async () => {
    for (const count of [0, null]) {
      mockAdmin.from.mockReset()
      const q = new QueryMock()
      q.payload = { data: null, error: null, count }
      mockAdmin.from.mockReturnValueOnce(q)
      expect(await cats.categoryHasChildren('a')).toBe(false)
    }
  })
})
