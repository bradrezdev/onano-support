import { describe, it, expect } from 'vitest'
import { sanitizeTipTap, extractPlainText } from './sanitize'

describe('sanitizeTipTap', () => {
  it('returns null for non-doc root', () => {
    expect(sanitizeTipTap(null)).toBeNull()
    expect(sanitizeTipTap(undefined)).toBeNull()
    expect(sanitizeTipTap({ type: 'paragraph', content: [] })).toBeNull()
    expect(sanitizeTipTap('plain string')).toBeNull()
    expect(sanitizeTipTap(42)).toBeNull()
  })

  it('returns empty doc when content is missing or invalid', () => {
    expect(sanitizeTipTap({ type: 'doc' })).toEqual({ type: 'doc', content: [] })
    expect(sanitizeTipTap({ type: 'doc', content: 'oops' })).toEqual({ type: 'doc', content: [] })
  })

  it('keeps allowed nodes (paragraph, bulletList, orderedList, listItem)', () => {
    const input = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'hello' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] }] },
        { type: 'orderedList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] }] },
      ],
    }
    const out = sanitizeTipTap(input)
    expect(out).not.toBeNull()
    expect(out?.content?.length).toBe(3)
    expect(out?.content?.[0]?.type).toBe('paragraph')
    expect(out?.content?.[1]?.type).toBe('bulletList')
    expect(out?.content?.[2]?.type).toBe('orderedList')
  })

  it('strips disallowed nodes (heading, image, codeBlock, blockquote)', () => {
    const input = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'danger' }] },
        { type: 'image', attrs: { src: 'https://evil/x.png' } },
        { type: 'codeBlock', content: [{ type: 'text', text: 'rm -rf /' }] },
        { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'safe' }] }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'kept' }] },
      ],
    }
    const out = sanitizeTipTap(input)
    expect(out?.content?.length).toBe(1)
    expect(out?.content?.[0]?.type).toBe('paragraph')
  })

  it('keeps only allowed marks (bold, italic, underline)', () => {
    const input = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'styled',
              marks: [{ type: 'bold' }, { type: 'italic' }, { type: 'underline' }, { type: 'strike' }, { type: 'code' }, { type: 'link', attrs: { href: 'https://evil' } }],
            },
          ],
        },
      ],
    }
    const out = sanitizeTipTap(input)
    const textNode = out?.content?.[0]?.content?.[0]
    expect(textNode?.type).toBe('text')
    expect(textNode?.marks).toEqual([{ type: 'bold' }, { type: 'italic' }, { type: 'underline' }])
  })

  it('drops unknown marks but keeps text node', () => {
    const input = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'highlight' }] }] }],
    }
    const out = sanitizeTipTap(input)
    const textNode = out?.content?.[0]?.content?.[0]
    expect(textNode?.type).toBe('text')
    expect(textNode?.marks).toBeUndefined()
  })

  it('handles text node with non-string text by coercing to empty string', () => {
    const input = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 123 }] }],
    }
    const out = sanitizeTipTap(input)
    expect(out?.content?.[0]?.content?.[0]?.text).toBe('')
  })

  it('strips dangerously: nested disallowed nodes are dropped but safe siblings kept', () => {
    const input = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                { type: 'image', attrs: { src: 'x' } },
                { type: 'paragraph', content: [{ type: 'text', text: 'safe' }] },
              ],
            },
          ],
        },
      ],
    }
    const out = sanitizeTipTap(input)
    const list = out?.content?.[0]
    const item = list?.content?.[0]
    expect(item?.content?.length).toBe(1)
    expect(item?.content?.[0]?.type).toBe('paragraph')
  })

  it('filters out non-object entries inside content arrays (flatMap dedupes)', () => {
    const input = {
      type: 'doc',
      content: [null, 'string', { type: 'paragraph', content: [{ type: 'text', text: 'kept' }] }],
    }
    const out = sanitizeTipTap(input)
    expect(out?.content?.length).toBe(1)
    expect(out?.content?.[0]?.type).toBe('paragraph')
  })
})

describe('extractPlainText', () => {
  it('returns empty string for non-object input', () => {
    expect(extractPlainText(null)).toBe('')
    expect(extractPlainText(undefined)).toBe('')
    expect(extractPlainText('plain')).toBe('')
    expect(extractPlainText(42)).toBe('')
  })

  it('extracts text in order and joins with single spaces', () => {
    const input = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'hello' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'world' }] },
      ],
    }
    expect(extractPlainText(input)).toBe('hello world')
  })

  it('collapses extra whitespace into single spaces', () => {
    const input = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a  b\tc\nd' }] }],
    }
    expect(extractPlainText(input)).toBe('a b c d')
  })

  it('recurses through nested lists', () => {
    const input = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'one' }] },
                {
                  type: 'bulletList',
                  content: [
                    {
                      type: 'listItem',
                      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }
    expect(extractPlainText(input)).toBe('one two')
  })
})
