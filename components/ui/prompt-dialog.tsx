"use client"

/**
 * Promise-based text prompt (replaces window.prompt; M9 Step 0, docs/parity/
 * m9.md "Dialogs"). `usePromptDialog()` returns `prompt(options)` →
 * `Promise<string | null>` (null on cancel/Esc) and the `dialog` element to
 * render once. Validation errors are announced through `aria-describedby`;
 * focus goes to the input and returns to the opener on close.
 */
import { lazy, Suspense, useCallback, useRef, useState, type ReactNode } from "react"

// M10 C: the dialog (and the dialog primitives) load on the first prompt.
const PromptDialog = lazy(() => import("@/components/ui/prompt-dialog-view").then((mod) => ({ default: mod.PromptDialog })))

export type PromptOptions = {
  title: string
  label: string
  description?: string
  defaultValue?: string
  placeholder?: string
  confirmLabel?: string
  cancelLabel?: string
  maxLength?: number
  /** Returns an error message, or null when the (trimmed) value is valid. */
  validate?: (value: string) => string | null
}

type PendingPrompt = PromptOptions & { resolve: (value: string | null) => void }

export function usePromptDialog(): {
  prompt: (options: PromptOptions) => Promise<string | null>
  dialog: ReactNode
} {
  const [pending, setPending] = useState<PendingPrompt | null>(null)
  const openerRef = useRef<HTMLElement | null>(null)

  const prompt = useCallback(
    (options: PromptOptions) =>
      new Promise<string | null>((resolve) => {
        openerRef.current = typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null)
        setPending({ ...options, resolve })
      }),
    []
  )

  const settle = useCallback(
    (value: string | null) => {
      pending?.resolve(value)
      setPending(null)
      const opener = openerRef.current

      openerRef.current = null
      if (opener && typeof opener.focus === "function") window.setTimeout(() => opener.focus(), 0)
    },
    [pending]
  )

  const dialog = pending ? (
    <Suspense fallback={null}>
      <PromptDialog key={pending.title} options={pending} onSettle={settle} />
    </Suspense>
  ) : null

  return { prompt, dialog }
}
