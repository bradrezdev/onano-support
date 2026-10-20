/**
 * TipTap document sanitizer. The schema is the recommended one from TipTap's
 * starter-kit, restricted to nodes/marks we actually want to expose (no
 * headings, no images, no embeds, no code blocks). Anything else is stripped.
 *
 * Use this on every TipTap JSON payload that comes from the client before
 * persisting it server-side. Persisted JSON is then safe to render with
 * RichTextRenderer (which only walks the same node/mark allowlist).
 */

const ALLOWED_NODES = new Set([
  'doc',
  'paragraph',
  'text',
  'bulletList',
  'orderedList',
  'listItem',
])

const ALLOWED_MARKS = new Set(['bold', 'italic', 'underline'])

interface TipTapNode {
  type?: string
  text?: string
  marks?: Array<{ type?: string }>
  content?: TipTapNode[]
}

export function sanitizeTipTap(input: unknown): TipTapNode | null {
  if (!isObject(input) || input.type !== 'doc') return null
  const out: TipTapNode = { type: 'doc', content: [] }
  if (Array.isArray(input.content)) {
    out.content = input.content.flatMap((c) => walk(c)).filter(Boolean) as TipTapNode[]
  }
  return out
}

export function extractPlainText(input: unknown): string {
  if (!isObject(input)) return ''
  const parts: string[] = []
  visit(input as TipTapNode)
  return parts.join(' ').replace(/\s+/g, ' ').trim()

  function visit(n: TipTapNode) {
    if (typeof n.text === 'string') {
      parts.push(n.text)
    } else if (Array.isArray(n.content)) {
      for (const c of n.content) visit(c)
    }
  }
}

function walk(n: unknown): TipTapNode[] {
  if (!isObject(n)) return []
  const node = n as TipTapNode
  if (!ALLOWED_NODES.has(node.type ?? '')) return []

  if (node.type === 'text') {
    const filteredMarks = Array.isArray(node.marks)
      ? node.marks.filter((m) => ALLOWED_MARKS.has(m.type ?? '')).map((m) => ({ type: m.type }))
      : []
    const marks = filteredMarks.length > 0 ? filteredMarks : undefined
    return [{ type: 'text', text: typeof node.text === 'string' ? node.text : '', ...(marks ? { marks } : {}) }]
  }

  const content = Array.isArray(node.content) ? node.content.flatMap((c) => walk(c)) : []
  const out: TipTapNode = { type: node.type, content }
  return [out]
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}