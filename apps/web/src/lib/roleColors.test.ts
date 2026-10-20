// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the api client before importing roleColors.
const mockGet = vi.fn()
vi.mock('./api', () => ({
  api: { get: mockGet },
}))

// Import AFTER mock.
const { loadRoleColors, bubbleStyle } = await import('./roleColors')

beforeEach(() => {
  mockGet.mockReset()
  document.documentElement.style.cssText = ''
})

describe('bubbleStyle', () => {
  it('returns color-mix with 0% white for fade_step 0', () => {
    const out = bubbleStyle('admin', 0)
    expect(out.backgroundColor).toBe('color-mix(in oklab, var(--role-admin), white 0%)')
    expect(out.borderColor).toBe('color-mix(in oklab, var(--role-admin), white 0%)')
  })

  it('increments white percentage by 12 per fade step (12, 24, 36)', () => {
    expect(bubbleStyle('admin', 1).backgroundColor).toBe(
      'color-mix(in oklab, var(--role-admin), white 12%)',
    )
    expect(bubbleStyle('admin', 2).backgroundColor).toBe(
      'color-mix(in oklab, var(--role-admin), white 24%)',
    )
    expect(bubbleStyle('admin', 3).backgroundColor).toBe(
      'color-mix(in oklab, var(--role-admin), white 36%)',
    )
  })

  it('maps each role to the corresponding CSS variable', () => {
    expect(bubbleStyle('supervisor', 0).backgroundColor).toContain('var(--role-supervisor)')
    expect(bubbleStyle('soporte', 0).backgroundColor).toContain('var(--role-soporte)')
  })

  it('caps white% at 88 even for very high fade_step', () => {
    expect(bubbleStyle('admin', 100).backgroundColor).toBe(
      'color-mix(in oklab, var(--role-admin), white 88%)',
    )
  })

  it('borderColor uses whitePct-20 (never below 0)', () => {
    // step 0 → border whitePct 0
    expect(bubbleStyle('admin', 0).borderColor).toBe(
      'color-mix(in oklab, var(--role-admin), white 0%)',
    )
    // step 1 → border whitePct = max(12-20, 0) = 0
    expect(bubbleStyle('admin', 1).borderColor).toBe(
      'color-mix(in oklab, var(--role-admin), white 0%)',
    )
    // step 3 → border whitePct = 36-20 = 16
    expect(bubbleStyle('admin', 3).borderColor).toBe(
      'color-mix(in oklab, var(--role-admin), white 16%)',
    )
  })
})

describe('loadRoleColors', () => {
  it('applies base_color to :root as CSS custom property per role', async () => {
    mockGet.mockResolvedValueOnce({
      data: [
        { role: 'admin', base_color: '#ff00ff', fade_steps: 10 },
        { role: 'supervisor', base_color: '#00ff00', fade_steps: 10 },
        { role: 'soporte', base_color: '#0000ff', fade_steps: 10 },
      ],
    })
    const out = await loadRoleColors(true)
    expect(out.length).toBe(3)
    expect(document.documentElement.style.getPropertyValue('--role-admin')).toBe('#ff00ff')
    expect(document.documentElement.style.getPropertyValue('--role-supervisor')).toBe('#00ff00')
    expect(document.documentElement.style.getPropertyValue('--role-soporte')).toBe('#0000ff')
  })

  it('returns cached value on second call without re-fetching', async () => {
    mockGet.mockResolvedValue({
      data: [{ role: 'admin', base_color: '#ff00ff', fade_steps: 10 }],
    })
    await loadRoleColors(true)
    const first = await loadRoleColors(false)
    expect(mockGet).toHaveBeenCalledTimes(1)
    expect(first.length).toBe(1)
  })

  it('forces a refetch when force=true', async () => {
    mockGet.mockResolvedValue({
      data: [{ role: 'admin', base_color: '#ff00ff', fade_steps: 10 }],
    })
    await loadRoleColors(true)
    await loadRoleColors(true)
    expect(mockGet).toHaveBeenCalledTimes(2)
  })

  it('warns and returns [] when the fetch fails (uses index.css defaults)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    mockGet.mockRejectedValueOnce(new Error('network'))
    const out = await loadRoleColors(true)
    expect(out).toEqual([])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
