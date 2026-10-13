"use client"

/**
 * M5 Step 0 stub (owner: Package C): typed props, renders nothing yet.
 */
import type { CreateClipInput, MeetingClip } from "@/lib/clips/types"

export type ClipCreateDialogProps = {
  meetingId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Range or selected segments the clip starts from. */
  selection?: CreateClipInput
  onCreated?: (clip: MeetingClip) => void
}

export function ClipCreateDialog(props: ClipCreateDialogProps) {
  void props
  return null
}
