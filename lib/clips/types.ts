/**
 * Clips contract (docs/parity/m5.md, Step 0; owner: Package C). Client-safe.
 */

export type ClipRenderStatus = "pending" | "ready" | "failed"

export type MeetingClip = {
  id: string
  workspaceId: string
  meetingId: string
  title: string
  startMs: number
  endMs: number
  segmentIds: string[]
  transcriptExcerpt?: string
  renderStatus: ClipRenderStatus
  /** `clips/<workspaceId>/<clipId>.m4a`; never the source recording. */
  storageKey?: string
  renderError?: string
  createdByUserId?: string
  createdAt: string
  updatedAt: string
}

/** A clip from an explicit range or from selected segments (min/max). */
export type CreateClipInput =
  | { startMs: number; endMs: number; title?: string }
  | { segmentIds: string[]; title?: string }

/** What a clip share token exposes: the clip and minimal meeting metadata. */
export type ClipShareView = {
  clip: MeetingClip
  meeting: { title: string; startedAt: string; language: string }
}

/** Minimum and default maximum clip length. */
export const CLIP_MIN_MS = 2000
export const CLIP_DEFAULT_MAX_MS = 600_000
