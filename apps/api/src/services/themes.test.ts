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
  insert(rows: unknown) { return this.record('insert', [rows]) }
  update(rows: unknown) { return this.record('update', [rows]) }
  delete() { return this }
  maybeSingle(): Promise<Response> { return Promise.resolve(this.payload) }
  single(): Promise<Response> {
    const d = Array.isArray(this.payload.data) ? this.payload.data[0] : this.payload.data
    return Promise.resolve({ ...this.payload, data: d })
  }
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

const themes = await import('./themes')

beforeEach(() => {
  mockAdmin.from.mockReset()
})

function setNextFrom(payload: Response): QueryMock {
  const q = new QueryMock()
  q.payload = payload
  mockAdmin.from.mockReturnValueOnce(q)
  return q
}

// ---------------------------------------------------------------------------
// listThemesWithFlows — groups flows by theme_id
// ---------------------------------------------------------------------------

describe('listThemesWithFlows', () => {
  it('returns themes with their flows grouped by theme_id', async () => {
    const themesQ = new QueryMock()
    themesQ.payload = {
      data: [
        { id: 't-1', name: 'Onboarding', description: null, color: '#000', position: 0, created_by: 'u-1', created_at: '2026-01-01', updated_at: '2026-01-01' },
        { id: 't-2', name: 'Billing', description: null, color: '#111', position: 1, created_by: 'u-1', created_at: '2026-01-01', updated_at: '2026-01-01' },
      ],
      error: null,
    }
    const flowsQ = new QueryMock()
    flowsQ.payload = {
      data: [
        { id: 'f-1', theme_id: 't-1', name: 'Nuevo', description: null, position: 0, is_terminal: false, created_at: '2026-01-01', updated_at: '2026-01-01' },
        { id: 'f-2', theme_id: 't-1', name: 'Listo', description: null, position: 1, is_terminal: true, created_at: '2026-01-01', updated_at: '2026-01-01' },
        { id: 'f-3', theme_id: 't-2', name: 'Pendiente', description: null, position: 0, is_terminal: false, created_at: '2026-01-01', updated_at: '2026-01-01' },
      ],
      error: null,
    }
    const groupsQ = new QueryMock()
    groupsQ.payload = {
      data: [
        { key: 'pendiente', label: 'Pendiente', position: 1, color: '#94a3b8' },
        { key: 'en_trabajo', label: 'En trabajo', position: 2, color: '#3b82f6' },
        { key: 'en_espera', label: 'En espera', position: 3, color: '#f59e0b' },
        { key: 'terminado', label: 'Terminado', position: 4, color: '#22c55e' },
      ],
      error: null,
    }
    mockAdmin.from
      .mockReturnValueOnce(themesQ)
      .mockReturnValueOnce(flowsQ)
      .mockReturnValueOnce(groupsQ)

    const out = await themes.listThemesWithFlows()
    expect(out.length).toBe(2)
    expect(out[0]!.flows.map((f) => f.name)).toEqual(['Nuevo', 'Listo'])
    expect(out[1]!.flows.map((f) => f.name)).toEqual(['Pendiente'])
    expect(out[0]!.groups.map((g) => g.key)).toEqual(['pendiente', 'en_trabajo', 'en_espera', 'terminado'])
  })

  it('returns empty flows array when a theme has none', async () => {
    const themesQ = new QueryMock()
    themesQ.payload = { data: [{ id: 't-1', name: 'X', description: null, color: '#000', position: 0, created_by: 'u-1', created_at: 'x', updated_at: 'x' }], error: null }
    const flowsQ = new QueryMock()
    flowsQ.payload = { data: [], error: null }
    const groupsQ = new QueryMock()
    groupsQ.payload = { data: [], error: null }
    mockAdmin.from
      .mockReturnValueOnce(themesQ)
      .mockReturnValueOnce(flowsQ)
      .mockReturnValueOnce(groupsQ)
    const out = await themes.listThemesWithFlows()
    expect(out[0]!.flows).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// findThemeOrThrow / findFlowOrThrow
// ---------------------------------------------------------------------------

describe('findThemeOrThrow / findFlowOrThrow', () => {
  it('throws ThemeError 404 when theme is missing', async () => {
    setNextFrom({ data: null, error: null })
    await expect(themes.findThemeOrThrow('missing')).rejects.toMatchObject({ status: 404, code: 'not_found' })
  })

  it('throws ThemeError 404 when flow is missing', async () => {
    setNextFrom({ data: null, error: null })
    await expect(themes.findFlowOrThrow('missing')).rejects.toMatchObject({ status: 404, code: 'not_found' })
  })
})

// ---------------------------------------------------------------------------
// createTheme — auto-position + defaults + duplicate handling
// ---------------------------------------------------------------------------

describe('createTheme', () => {
  it('places new theme at position == current count (end of list)', async () => {
    // 1) count query
    const countQ = new QueryMock()
    countQ.payload = { data: null, error: null, count: 3 }
    // 2) insert
    const insertQ = new QueryMock()
    insertQ.payload = {
      data: { id: 't-new', name: 'Onboarding', description: null, color: '#6366f1', position: 3, created_by: 'u-1', created_at: '2026-01-01', updated_at: '2026-01-01' },
      error: null,
    }
    mockAdmin.from.mockReturnValueOnce(countQ).mockReturnValueOnce(insertQ)

    const out = await themes.createTheme({ name: '  Onboarding  ' }, 'u-1')
    expect(out.id).toBe('t-new')
    expect(out.position).toBe(3)
    expect(out.color).toBe('#6366f1') // default

    // Insert call should have trimmed the name
    const insertCall = insertQ.ops.find((o) => o.op === 'insert')!
    const insertedRow = insertCall.args[0] as Record<string, unknown>
    expect(insertedRow.name).toBe('Onboarding')
    expect(insertedRow.created_by).toBe('u-1')
  })

  it('uses count = 0 when previous themes are empty', async () => {
    const countQ = new QueryMock()
    countQ.payload = { data: null, error: null, count: 0 }
    const insertQ = new QueryMock()
    insertQ.payload = {
      data: { id: 't-first', name: 'A', description: null, color: '#6366f1', position: 0, created_by: 'u-1', created_at: 'x', updated_at: 'x' },
      error: null,
    }
    mockAdmin.from.mockReturnValueOnce(countQ).mockReturnValueOnce(insertQ)
    const out = await themes.createTheme({ name: 'A' }, 'u-1')
    expect(out.position).toBe(0)
  })

  it('uses count = null as 0 (defensive)', async () => {
    const countQ = new QueryMock()
    countQ.payload = { data: null, error: null, count: null }
    const insertQ = new QueryMock()
    insertQ.payload = {
      data: { id: 't-x', name: 'A', description: null, color: '#abc', position: 0, created_by: 'u-1', created_at: 'x', updated_at: 'x' },
      error: null,
    }
    mockAdmin.from.mockReturnValueOnce(countQ).mockReturnValueOnce(insertQ)
    const out = await themes.createTheme({ name: 'A', color: '#abc' }, 'u-1')
    expect(out.position).toBe(0)
  })

  it('treats Postgres unique-violation (23505) as ThemeError 409 duplicate', async () => {
    const countQ = new QueryMock()
    countQ.payload = { data: null, error: null, count: 1 }
    const insertQ = new QueryMock()
    insertQ.payload = { data: null, error: { code: '23505', message: 'dup' } }
    mockAdmin.from.mockReturnValueOnce(countQ).mockReturnValueOnce(insertQ)
    await expect(themes.createTheme({ name: 'A' }, 'u-1')).rejects.toMatchObject({
      status: 409,
      code: 'duplicate',
    })
  })

  it('propagates non-duplicate errors as-is', async () => {
    const countQ = new QueryMock()
    countQ.payload = { data: null, error: null, count: 0 }
    const insertQ = new QueryMock()
    insertQ.payload = { data: null, error: { code: '9999', message: 'db down' } }
    mockAdmin.from.mockReturnValueOnce(countQ).mockReturnValueOnce(insertQ)
    await expect(themes.createTheme({ name: 'A' }, 'u-1')).rejects.toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// deleteFlow — refuses when tickets reference it
// ---------------------------------------------------------------------------

describe('deleteFlow', () => {
  it('refuses with 409 flow_in_use when any ticket points to the flow', async () => {
    const countQ = new QueryMock()
    countQ.payload = { data: null, error: null, count: 2 }
    mockAdmin.from.mockReturnValueOnce(countQ)
    await expect(themes.deleteFlow('f-1')).rejects.toMatchObject({
      status: 409,
      code: 'flow_in_use',
    })
  })

  it('deletes when no tickets reference the flow', async () => {
    const countQ = new QueryMock()
    countQ.payload = { data: null, error: null, count: 0 }
    const delQ = new QueryMock()
    delQ.payload = { data: null, error: null }
    mockAdmin.from.mockReturnValueOnce(countQ).mockReturnValueOnce(delQ)
    await expect(themes.deleteFlow('f-1')).resolves.toBeUndefined()
  })

  it('uses count = null as 0 (would proceed)', async () => {
    const countQ = new QueryMock()
    countQ.payload = { data: null, error: null, count: null }
    const delQ = new QueryMock()
    delQ.payload = { data: null, error: null }
    mockAdmin.from.mockReturnValueOnce(countQ).mockReturnValueOnce(delQ)
    await expect(themes.deleteFlow('f-1')).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// reorderFlows — parallel updates with position index
// ---------------------------------------------------------------------------

describe('reorderFlows', () => {
  it('updates each flow with its new position in a single parallel pass', async () => {
    const updated = [
      { id: 'f-3', theme_id: 't-1', name: 'C', position: 0, is_terminal: false, description: null, created_at: 'x', updated_at: 'x' },
      { id: 'f-1', theme_id: 't-1', name: 'A', position: 1, is_terminal: false, description: null, created_at: 'x', updated_at: 'x' },
      { id: 'f-2', theme_id: 't-1', name: 'B', position: 2, is_terminal: true, description: null, created_at: 'x', updated_at: 'x' },
    ]
    // Each update call resolves in the configured order; vitest consumes in order.
    for (const row of updated) {
      const q = new QueryMock()
      q.payload = { data: row, error: null }
      mockAdmin.from.mockReturnValueOnce(q)
    }
    const out = await themes.reorderFlows('t-1', ['f-3', 'f-1', 'f-2'])
    expect(out.map((f) => f.name)).toEqual(['C', 'A', 'B'])
    expect(mockAdmin.from).toHaveBeenCalledTimes(3)
  })

  it('throws when any update fails', async () => {
    const ok = new QueryMock()
    ok.payload = { data: { id: 'f-1', theme_id: 't-1', name: 'A', position: 0, is_terminal: false, description: null, created_at: 'x', updated_at: 'x' }, error: null }
    const bad = new QueryMock()
    bad.payload = { data: null, error: { message: 'rls' } }
    mockAdmin.from.mockReturnValueOnce(ok).mockReturnValueOnce(bad).mockReturnValueOnce(ok)
    await expect(themes.reorderFlows('t-1', ['f-1', 'f-2', 'f-3'])).rejects.toBeDefined()
  })

  it('returns [] when no flows to reorder', async () => {
    const out = await themes.reorderFlows('t-1', [])
    expect(out).toEqual([])
    expect(mockAdmin.from).not.toHaveBeenCalled()
  })
})
