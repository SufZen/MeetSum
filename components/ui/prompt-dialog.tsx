"use client"

/**
 * Promise-based text prompt (replaces window.prompt; M9 Step 0, docs/parity/
 * m9.md "Dialogs"). `usePromptDialog()` returns `prompt(options)` →
 * `Promise<string | null>` (null on cancel/Esc) and the `dialog` element to
 * render once. Validation errors are announced through `aria-describedby`;
 * focus goes to the input and returns to the opener on close.
 */
import { useCallback, useId, useRef, useState, type FormEvent, type ReactNode } from "react"

import { useOptionalI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

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

  const dialog = pending ? <PromptDialog key={pending.title} options={pending} onSettle={settle} /> : null

  return { prompt, dialog }
}

function PromptDialog({ options, onSettle }: { options: PromptOptions; onSettle: (value: string | null) => void }) {
  const i18n = useOptionalI18n()
  const [value, setValue] = useState(options.defaultValue ?? "")
  const [error, setError] = useState<string | null>(null)
  const inputId = useId()
  const errorId = useId()
  const descriptionId = useId()

  function submit(event: FormEvent) {
    event.preventDefault()
    const trimmed = value.trim()
    const message = options.validate?.(trimmed) ?? null

    if (message) {
      setError(message)
      return
    }

    onSettle(trimmed)
  }

  const describedBy = [options.description ? descriptionId : "", error ? errorId : ""].filter(Boolean).join(" ")

  return (
    <Dialog open onOpenChange={(open) => !open && onSettle(null)}>
      <DialogContent showCloseButton={false}>
        <form onSubmit={submit} noValidate className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{options.title}</DialogTitle>
            {options.description ? (
              <DialogDescription id={descriptionId}>{options.description}</DialogDescription>
            ) : null}
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor={inputId}>{options.label}</Label>
            <Input
              id={inputId}
              autoFocus
              dir="auto"
              value={value}
              maxLength={options.maxLength}
              placeholder={options.placeholder}
              aria-invalid={error ? true : undefined}
              aria-describedby={describedBy || undefined}
              onChange={(event) => {
                setValue(event.target.value)
                if (error) setError(null)
              }}
            />
            {error ? (
              <p id={errorId} role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onSettle(null)}>
              {options.cancelLabel ?? i18n?.t("shellPromptCancel") ?? "Cancel"}
            </Button>
            <Button type="submit">{options.confirmLabel ?? i18n?.t("shellPromptSubmit") ?? "OK"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
