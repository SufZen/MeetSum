"use client"

import { useEffect, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import type { Dictionary } from "@/lib/i18n/dictionaries"

/**
 * Inline editor for one transcript line (M4 C4). The text being typed has no
 * known language yet, so it is the one place transcript text uses
 * `dir="auto"`. Ctrl/⌘+Enter saves, Esc cancels.
 */
export function SegmentEditor({
  initialText,
  originalText = initialText,
  saving,
  dictionary: t,
  onSave,
  onCancel,
}: {
  initialText: string
  /** Stored text; saving it unchanged just closes the editor. */
  originalText?: string
  saving?: boolean
  dictionary: Dictionary
  onSave: (text: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState(initialText)
  const ref = useRef<HTMLTextAreaElement>(null)
  const trimmed = text.normalize("NFC").trim()

  useEffect(() => {
    const element = ref.current

    if (!element) return
    element.focus()
    element.setSelectionRange(element.value.length, element.value.length)
  }, [])

  const save = () => {
    if (!trimmed || saving) return
    if (trimmed === originalText.trim()) {
      onCancel()
      return
    }
    onSave(trimmed)
  }

  return (
    <div className="grid gap-2">
      <Textarea
        ref={ref}
        dir="auto"
        value={text}
        aria-label={t.transcriptEditLabel}
        maxLength={5000}
        disabled={saving}
        className="min-h-20 text-md"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault()
            event.stopPropagation()
            onCancel()
          }
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            save()
          }
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" disabled={!trimmed || saving} onClick={save}>
          {t.transcriptEditSave}
        </Button>
        <Button size="sm" variant="ghost" disabled={saving} onClick={onCancel}>
          {t.transcriptEditCancel}
        </Button>
        <span className="text-xs text-fg-3">{t.transcriptEditHint}</span>
      </div>
    </div>
  )
}
