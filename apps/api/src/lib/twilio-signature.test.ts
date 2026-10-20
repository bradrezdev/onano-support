import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { verifyTwilioSignature } from './twilio-signature'

const AUTH = 'test-auth-token'

function expectedSignature(fullUrl: string, params: Record<string, string>, authToken: string) {
  const sortedKeys = Object.keys(params).sort()
  const data = fullUrl + sortedKeys.map((k) => k + params[k]).join('')
  return createHmac('sha1', authToken).update(data).digest('base64')
}

describe('verifyTwilioSignature', () => {
  const fullUrl = 'https://example.com/api/webhooks/twilio'
  const params = { From: '+541112345678', Body: 'hola', To: 'whatsapp:+14155550001' }

  it('returns true when auth token is undefined (dev mode)', () => {
    expect(verifyTwilioSignature(null, fullUrl, params, undefined)).toBe(true)
    expect(verifyTwilioSignature('whatever', fullUrl, params, undefined)).toBe(true)
  })

  it('returns false when signature header is missing and token is set', () => {
    expect(verifyTwilioSignature(null, fullUrl, params, AUTH)).toBe(false)
    expect(verifyTwilioSignature('', fullUrl, params, AUTH)).toBe(false)
  })

  it('accepts a correctly-computed signature', () => {
    const sig = expectedSignature(fullUrl, params, AUTH)
    expect(verifyTwilioSignature(sig, fullUrl, params, AUTH)).toBe(true)
  })

  it('rejects a signature computed with the wrong token', () => {
    const sig = expectedSignature(fullUrl, params, 'different-token')
    expect(verifyTwilioSignature(sig, fullUrl, params, AUTH)).toBe(false)
  })

  it('rejects a signature computed for a different URL', () => {
    const sig = expectedSignature('https://evil.example.com/webhook', params, AUTH)
    expect(verifyTwilioSignature(sig, fullUrl, params, AUTH)).toBe(false)
  })

  it('rejects a signature when the params differ', () => {
    const sig = expectedSignature(fullUrl, { ...params, Body: 'tampered' }, AUTH)
    expect(verifyTwilioSignature(sig, fullUrl, params, AUTH)).toBe(false)
  })

  it('rejects malformed signature without throwing', () => {
    expect(verifyTwilioSignature('not-base64!@#', fullUrl, params, AUTH)).toBe(false)
  })

  it('sorts POST parameters alphabetically before signing (a key ordering invariant)', () => {
    const sig = expectedSignature(fullUrl, params, AUTH)
    // Reorder input keys; result must be identical because signing sorts.
    const reordered = {
      To: params.To,
      From: params.From,
      Body: params.Body,
    }
    expect(verifyTwilioSignature(sig, fullUrl, reordered, AUTH)).toBe(true)
  })

  it('returns false when signature length differs from expected digest', () => {
    // Use a too-short valid base64 string of unequal length; timingSafeEqual
    // path must short-circuit on length mismatch without throwing.
    expect(verifyTwilioSignature('AAAA', fullUrl, params, AUTH)).toBe(false)
  })
})
