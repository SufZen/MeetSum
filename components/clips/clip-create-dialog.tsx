"use client"

/**
 * "Create clip" dialog (M5 C5) for a range or a set of selected segments.
 * The server validates the range (≥ 2 s, ≤ 10 min, inside the meeting) and
 * derives the default title from the excerpt.
 */
import { useState } from "react"
import { toast } from "sonner"

import { notifyClipsChanged } from "@/components/clips/clip-list"
import { CollabRequestError, collabApi, useCollabStrings } from "@/components/comments/collab-client"
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
import { formatClipClock } from "@/lib/clips/range"
import type { ClipWire, CreateClipInput, MeetingClip } from "@/lib/clips/types"

export type ClipCreateDialogProps = {
  meetingId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Range or selected segments the clip starts from. */
  selection?: CreateClipInput
  /** Range shown in the dialog for a segment selection. */
  previewRange?: { startMs: number; endMs: number }
  onCreated?: (clip: MeetingClip | ClipWire) => void
}

export function ClipCreateDialog(props: ClipCreateDialogProps) {
  const { t } = useCollabStrings()

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.clipsDialogTitle}</DialogTitle>
          <DialogDescription>{t.clipsDialogDescription}</DialogDescription>
        </DialogHeader>
        {/* Mounted per opening, so the title field starts fresh each time. */}
        {props.open ? <ClipCreateForm {...props} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function ClipCreateForm({ meetingId, onOpenChange, selection, previewRange, onCreated }: ClipCreateDialogProps) {
  const { t } = useCollabStrings()
  const [title, setTitle] = useState(() =>
    selection && "title" in selection ? (selection.title ?? "") : ""
  )
  const [busy, setBusy] = useState(false)
  const range =
    selection && "startMs" in selection ? { startMs: selection.startMs, endMs: selection.endMs } : previewRange

  const errorMessage = (error: unknown) => {
    const code = error instanceof CollabRequestError ? error.code : undefined

    if (code === "too_short") return t.clipsErrorTooShort
    if (code === "too_long") return t.clipsErrorTooLong
    if (code === "out_of_bounds") return t.clipsErrorOutOfBounds
    return t.clipsCreateFailed
  }

  const submit = async () => {
    if (!selection || busy) return
    setBusy(true)
    try {
      const trimmed = title.trim()
      const { clip } = await collabApi.createClip(meetingId, {
        ...selection,
        ...(trimmed ? { title: trimmed } : {}),
      } as CreateClipInput)

      toast.success(t.clipsCreated)
      notifyClipsChanged(meetingId)
      onCreated?.(clip)
      onOpenChange(false)
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      {range ? (
        <p className="text-sm text-fg-2">
          {t.clipsRangeLabel}:{" "}
          <span className="font-mono tabular-nums [direction:ltr] [unicode-bidi:isolate]">
            {formatClipClock(range.startMs)}–{formatClipClock(range.endMs)} (
            {formatClipClock(range.endMs - range.startMs)})
          </span>
        </p>
      ) : null}
      <div className="grid gap-1.5">
        <Label htmlFor="clip-title">{t.clipsTitleLabel}</Label>
        <Input
          id="clip-title"
          dir="auto"
          value={title}
          maxLength={200}
          placeholder={t.clipsTitlePlaceholder}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          {t.clipsCancel}
        </Button>
        <Button type="submit" disabled={busy || !selection}>
          {t.clipsCreate}
        </Button>
      </DialogFooter>
    </form>
  )
}
