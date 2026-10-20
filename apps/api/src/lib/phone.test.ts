import { describe, it, expect } from 'vitest'
import { normalizePhone, isLikelyWhatsapp } from './phone'

describe('normalizePhone', () => {
  it('returns input untouched when empty after trim', () => {
    expect(normalizePhone('')).toBe('')
    expect(normalizePhone('   ')).toBe('')
  })

  it('prepends + and strips non-digits', () => {
    expect(normalizePhone('541112345678')).toBe('+541112345678')
    expect(normalizePhone('+54 11 1234-5678')).toBe('+541112345678')
    expect(normalizePhone('whatsapp:+5491145678901')).toBe('+5491145678901')
  })

  it('trims surrounding whitespace before normalizing', () => {
    expect(normalizePhone('  +1 415 555 0001  ')).toBe('+14155550001')
  })

  it('adds + even when input had no plus', () => {
    expect(normalizePhone('(5411) 1234-5678')).toBe('+541112345678')
  })

  it('returns + plus nothing when only non-digit chars are provided', () => {
    expect(normalizePhone('() - ')).toBe('+')
    expect(normalizePhone('abc')).toBe('+')
  })
})

describe('isLikelyWhatsapp', () => {
  it('accepts numbers between 8 and 15 digits', () => {
    expect(isLikelyWhatsapp('+541112345678')).toBe(true)
    expect(isLikelyWhatsapp('+18091234567')).toBe(true)
    expect(isLikelyWhatsapp('+180912345678901')).toBe(true)
  })

  it('rejects numbers below 8 digits', () => {
    expect(isLikelyWhatsapp('+1234567')).toBe(false)
    expect(isLikelyWhatsapp('+541')).toBe(false)
  })

  it('rejects numbers above 15 digits', () => {
    expect(isLikelyWhatsapp('+1234567890123456')).toBe(false)
  })

  it('ignores formatting characters when counting digits', () => {
    expect(isLikelyWhatsapp('+54 11 1234-5678')).toBe(true)
    expect(isLikelyWhatsapp('(5411) 123-4567')).toBe(true)
  })
})
