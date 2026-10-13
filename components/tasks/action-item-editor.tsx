"use client"

/**
 * M5 Step 0 stub (owner: Package B): typed props, renders nothing yet.
 */
import type { ActionItem, MeetingParticipant, MeetingSpeaker } from "@/lib/meetings/repository"
import type { TaskMember } from "@/lib/tasks/types"

export type ActionItemEditorProps = {
  meetingId: string
  items: ActionItem[]
  participants: MeetingParticipant[]
  speakers: MeetingSpeaker[]
  members: TaskMember[]
  /** ISO datetime; anchor for relative due phrases. */
  meetingStartedAt: string
  onChanged?: (items: ActionItem[]) => void
}

export function ActionItemEditor(props: ActionItemEditorProps) {
  void props
  return null
}
