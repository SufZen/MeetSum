"use client"

import { useState } from "react"

import { useOptionalI18n } from "@/components/i18n-provider"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

/**
 * Controlled confirmation dialog (replaces window.confirm). `onConfirm`
 * may be async; the dialog stays open and disabled until it settles.
 * Promoted to `components/ui` in M9 Step 0 (`components/admin/confirm-dialog`
 * re-exports it). The title is wrapped in <bdi> (object names); labels default
 * to the dictionary's `shellConfirmDefault` / `shellConfirmCancel`.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  destructive = true,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  onConfirm: () => void | Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const i18n = useOptionalI18n()
  const confirmText = confirmLabel ?? i18n?.t("shellConfirmDefault") ?? "OK"
  const cancelText = cancelLabel ?? i18n?.t("shellConfirmCancel") ?? "Cancel"

  async function confirm() {
    setBusy(true)
    try {
      await onConfirm()
      onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => !busy && onOpenChange(next)}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            <bdi>{title}</bdi>
          </AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{cancelText}</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? "destructive" : "default"}
            disabled={busy}
            onClick={() => void confirm()}
          >
            {confirmText}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
