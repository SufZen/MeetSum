"use client"

/** The prompt dialog body for `usePromptDialog()` (its own chunk since M10 C). */
import { useId, useState, type FormEvent } from "react"

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
import type { PromptOptions } from "@/components/ui/prompt-dialog"

export function PromptDialog({ options, onSettle }: { options: PromptOptions; onSettle: (value: string | null) => void }) {
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
