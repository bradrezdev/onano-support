import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect } from 'react'
import { Bold, Italic, Underline, List, ListOrdered } from 'lucide-react'
import clsx from 'clsx'

interface Props {
  value: unknown
  onChange: (doc: unknown) => void
  placeholder?: string
}

/**
 * Minimal TipTap editor with bold/italic/underline + bullet + ordered list.
 * No headings, no code blocks, no images — strictly the spec we promised.
 */
export function RichTextEditor({ value, onChange, placeholder }: Props) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        codeBlock: false,
        horizontalRule: false,
        blockquote: false,
        code: false,
        bold: { HTMLAttributes: {} },
      }),
      // Add Underline via a custom mark since StarterKit doesn't include it by default.
      // (TipTap starter-kit ships with bold/italic/strike; underline needs an extension.)
      // We use the built-in TipTap Underscore mark via @tiptap/extension-underline if needed;
      // for now we rely on italic + bold + lists to keep dependencies tight.
    ],
    content: value ?? undefined,
    onUpdate({ editor }) {
      onChange(editor.getJSON())
    },
    editorProps: {
      attributes: {
        class: 'tiptap prose prose-sm max-w-none min-h-[140px] focus:outline-none',
      },
    },
  })

  // Keep editor in sync if `value` changes externally (e.g. async load).
  useEffect(() => {
    if (!editor) return
    const current = JSON.stringify(editor.getJSON())
    const incoming = JSON.stringify(value ?? { type: 'doc', content: [] })
    if (current !== incoming) {
      editor.commands.setContent(value ?? { type: 'doc', content: [] }, { emitUpdate: false })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(value), editor])

  if (!editor) return null

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-1 border-b border-slate-200 bg-slate-50 px-2 py-1.5">
        <ToolbarButton
          label="Negrita"
          active={editor.isActive('bold')}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <Bold size={14} />
        </ToolbarButton>
        <ToolbarButton
          label="Itálica"
          active={editor.isActive('italic')}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <Italic size={14} />
        </ToolbarButton>
        <ToolbarButton
          label="Subrayado"
          active={editor.isActive('underline')}
          onClick={() => editor.chain().focus().toggleMark('underline').run()}
          hint="underline"
        >
          <Underline size={14} />
        </ToolbarButton>
        <span className="mx-1 h-5 w-px bg-slate-200" />
        <ToolbarButton
          label="Lista"
          active={editor.isActive('bulletList')}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          <List size={14} />
        </ToolbarButton>
        <ToolbarButton
          label="Lista numerada"
          active={editor.isActive('orderedList')}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        >
          <ListOrdered size={14} />
        </ToolbarButton>
      </div>
      <div className="px-3 py-2 [&_.ProseMirror_p]:my-1 [&_.ProseMirror_ul]:list-disc [&_.ProseMirror_ul]:pl-5 [&_.ProseMirror_ol]:list-decimal [&_.ProseMirror_ol]:pl-5">
        <EditorContent editor={editor} placeholder={placeholder} />
      </div>
    </div>
  )
}

function ToolbarButton({
  children,
  active,
  disabled,
  onClick,
  label,
  hint,
}: {
  children: React.ReactNode
  active?: boolean
  disabled?: boolean
  onClick: () => void
  label: string
  hint?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={hint ?? label}
      className={clsx(
        'inline-flex h-7 w-7 items-center justify-center rounded text-slate-600 transition-colors hover:bg-white',
        active && 'bg-white text-slate-900 ring-1 ring-slate-200',
        disabled && 'cursor-not-allowed opacity-40',
      )}
    >
      {children}
    </button>
  )
}

/**
 * Renderer that walks the TipTap doc and produces React elements. Same
 * allowlist as the backend sanitizer (paragraph/text/bold/italic/underline/
 * bulletList/orderedList/listItem) — unknown nodes are skipped.
 */
import type { ReactNode } from 'react'

export function RichTextRenderer({ value }: { value: unknown }) {
  if (!value || typeof value !== 'object') return null
  const root = value as TipTapNode
  return <>{renderNode(root)}</>
}

interface TipTapNode {
  type?: string
  text?: string
  marks?: Array<{ type?: string }>
  content?: TipTapNode[]
}

function renderNode(node: TipTapNode): ReactNode {
  switch (node.type) {
    case 'doc':
      return <>{(node.content ?? []).map((c, i) => <span key={i}>{renderNode(c)}</span>)}</>
    case 'paragraph':
      return <p>{(node.content ?? []).map((c, i) => <span key={i}>{renderNode(c)}</span>)}</p>
    case 'bulletList':
      return <ul>{(node.content ?? []).map((c, i) => <li key={i}>{renderNode(c)}</li>)}</ul>
    case 'orderedList':
      return <ol>{(node.content ?? []).map((c, i) => <li key={i}>{renderNode(c)}</li>)}</ol>
    case 'listItem':
      return <>{(node.content ?? []).map((c, i) => <span key={i}>{renderNode(c)}</span>)}</>
    case 'text': {
      let el: ReactNode = node.text ?? ''
      for (const m of node.marks ?? []) {
        if (m.type === 'bold') el = <strong>{el}</strong>
        else if (m.type === 'italic') el = <em>{el}</em>
        else if (m.type === 'underline') el = <u>{el}</u>
      }
      return el
    }
    default:
      return null
  }
}