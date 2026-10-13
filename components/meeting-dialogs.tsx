"use client"

/**
 * Meeting confirm/rename dialogs, split out of the meeting view so they load
 * on demand (next/dynamic) instead of in the `/[locale]` first-load bundle.
 */
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
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { formatMessage, type Dictionary } from "@/lib/i18n/dictionaries"

export function RenameMeetingDialog({
  dictionary,
  open,
  onOpenChange,
  value,
  maxLength,
  busy,
  onValueChange,
  onSubmit,
}: {
  dictionary: Dictionary
  open: boolean
  onOpenChange: (open: boolean) => void
  value: string
  maxLength: number
  busy: boolean
  onValueChange: (value: string) => void
  onSubmit: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            onSubmit()
          }}
        >
          <DialogHeader>
            <DialogTitle>{dictionary.meetingRenameTitle}</DialogTitle>
          </DialogHeader>
          <label className="grid gap-1.5 text-sm font-medium">
            {dictionary.meetingRenameLabel}
            <Input
              dir="auto"
              autoFocus
              value={value}
              maxLength={maxLength}
              onChange={(event) => onValueChange(event.target.value)}
            />
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
              {dictionary.cancel}
            </Button>
            <Button type="submit" disabled={busy || !value.trim()}>
              {dictionary.meetingRenameSave}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function DeleteMeetingDialog({
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
  title: string
  busy: boolean
  onConfirm: () => void
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{formatMessage(dictionary.meetingDeleteTitle, { title })}</AlertDialogTitle>
          <AlertDialogDescription>{dictionary.meetingDeleteDescription}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{dictionary.cancel}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={busy} onClick={onConfirm}>
            {dictionary.meetingDeleteConfirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function ReprocessConfirmDialog({
  dictionary,
  open,
  onOpenChange,
  editedCount,
  onConfirm,
}: {
  dictionary: Dictionary
  open: boolean
  onOpenChange: (open: boolean) => void
  editedCount: number
  onConfirm: () => void
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{dictionary.transcriptReprocessTitle}</AlertDialogTitle>
          <AlertDialogDescription>
            {formatMessage(dictionary.transcriptReprocessDescription, { count: editedCount })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{dictionary.cancel}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            {dictionary.transcriptReprocessConfirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
