import { describe, it, expect } from 'vitest'
import { previewSnippet } from './conversations'

describe('previewSnippet', () => {
  it('returns empty-sentinel for null/undefined', () => {
    expect(previewSnippet(null)).toBe('(sin contenido)')
    expect(previewSnippet(undefined as unknown as null)).toBe('(sin contenido)')
  })

  it('returns one-line text trimmed', () => {
    expect(previewSnippet('hola mundo')).toBe('hola mundo')
    expect(previewSnippet('   espacios   ')).toBe('espacios')
  })

  it('collapses internal whitespace into single spaces', () => {
    expect(previewSnippet('hola\nmundo\tcruel')).toBe('hola mundo cruel')
    expect(previewSnippet('a  b   c')).toBe('a b c')
  })

  it('truncates with ellipsis beyond default 80 chars', () => {
    const longText = 'a'.repeat(120)
    const out = previewSnippet(longText)
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(80)
  })

  it('does not truncate text exactly at the limit', () => {
    const text = 'a'.repeat(80)
    expect(previewSnippet(text)).toBe(text)
  })

  it('honors custom max', () => {
    expect(previewSnippet('abcdefghij', 5)).toBe('abcd…')
    expect(previewSnippet('abcd', 5)).toBe('abcd')
  })

  it('treats empty string as missing content (UI placeholder)', () => {
    // Empty body is equivalent to no message body for UX — show the placeholder.
    expect(previewSnippet('')).toBe('(sin contenido)')
  })
})
