/**
 * Tasks contract (docs/parity/m5.md, Step 0; owner: Package B). Client-safe:
 * type-only imports.
 */
import type { ActionItem, MeetingParticipant, MeetingSpeaker } from "@/lib/meetings/repository"

export type TaskScope = "mine" | "all"

export type TaskStatusFilter = "open" | "done" | "overdue" | "all"

export type TaskSort = "due" | "created"

export type TaskListQuery = {
  scope: TaskScope
  status: TaskStatusFilter
  roomId?: string
  meetingId?: string
  ownerUserId?: string
  /** `YYYY-MM-DD`, inclusive. */
  dueFrom?: string
  /** `YYYY-MM-DD`, inclusive. */
  dueTo?: string
  q?: string
  sort?: TaskSort
  /** Opaque keyset cursor over `(due_on, created_at, id)`. */
  cursor?: string
  /** At most 100. */
  limit?: number
}

export type TaskRow = ActionItem & {
  meeting: { id: string; title: string; startedAt: string }
}

export type TaskListPage = {
  tasks: TaskRow[]
  nextCursor?: string
}

/** A workspace member an action item can be assigned to. */
export type TaskMember = {
  userId: string
  email: string
  name?: string
}

/** Context for owner resolution, priority and enrichment. */
export type TaskEnrichContext = {
  /** ISO datetime the meeting started (due-date anchor). */
  meetingStartedAt: string
  /** IANA zone; defaults to `Asia/Jerusalem`. */
  timeZone?: string
  speakers: MeetingSpeaker[]
  participants: MeetingParticipant[]
  members: TaskMember[]
}
