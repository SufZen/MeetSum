"use client"

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
import { BdiMessage } from "@/components/bot/bdi-message"
import type { Dictionary } from "@/lib/i18n/dictionaries"

/** Alert-dialog confirm before the bot leaves a live meeting (no window.confirm). */
export function StopBotDialog({
  dictionary,
  open,
  onOpenChange,
  title,
  busy,
  onConfirm,
}: {
  dictionary: Dictionary
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string | null
  busy?: boolean
  onConfirm: () => void
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            <BdiMessage
              template={dictionary.botStopConfirmTitle}
              values={{ title: title || dictionary.botDockUntitled }}
            />
          </AlertDialogTitle>
          <AlertDialogDescription>{dictionary.botStopConfirmDescription}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{dictionary.cancel}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={busy} onClick={onConfirm}>
            {dictionary.botStop}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
