"use client"

import { useState } from "react"

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
  confirmLabel: string
  cancelLabel: string
  destructive?: boolean
  onConfirm: () => void | Promise<void>
}) {
  const [busy, setBusy] = useState(false)

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
          <AlertDialogCancel disabled={busy}>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? "destructive" : "default"}
            disabled={busy}
            onClick={() => void confirm()}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
