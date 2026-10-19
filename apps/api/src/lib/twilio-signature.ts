/**
 * Twilio request signature validation.
 * https://www.twilio.com/docs/usage/security#validating-requests
 *
 * Without the official `twilio` npm package we implement the HMAC-SHA1
 * verification directly. Algorithm:
 *   1. Concatenate the full request URL (incl. query string) with the
 *      POST keys + values (Alphabetically sorted by key).
 *   2. HMAC-SHA1 the concatenation with the AuthToken.
 *   3. Base64-encode the digest.
 *   4. Compare constant-time against the X-Twilio-Signature header.
 *
 * If TWILIO_AUTH_TOKEN is not set, validation is skipped (development).
 * In production set TWILIO_AUTH_TOKEN in apps/api/.env.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

export function verifyTwilioSignature(
  signatureHeader: string | null,
  fullUrl: string,
  params: Record<string, string>,
  authToken: string | undefined,
): boolean {
  if (!authToken) {
    // No token configured: dev mode. Caller decides whether to allow.
    return true
  }
  if (!signatureHeader) return false

  const sortedKeys = Object.keys(params).sort()
  const data = fullUrl + sortedKeys.map((k) => k + params[k]).join('')
  const expected = createHmac('sha1', authToken).update(data).digest('base64')

  const a = Buffer.from(expected)
  const b = Buffer.from(signatureHeader)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}