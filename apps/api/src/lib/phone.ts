/**
 * Lightweight phone helpers — normalize to E.164 with a `+` and digits only.
 * Not as robust as libphonenumber but enough for the WhatsApp use case
 * where the number already comes from Twilio in E.164-ish form.
 */

export function normalizePhone(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return trimmed
  const hasPlus = trimmed.startsWith('+')
  const digits = trimmed.replace(/\D/g, '')
  return hasPlus ? `+${digits}` : `+${digits}`
}

export function isLikelyWhatsapp(number: string): boolean {
  const digits = number.replace(/\D/g, '')
  return digits.length >= 8 && digits.length <= 15
}