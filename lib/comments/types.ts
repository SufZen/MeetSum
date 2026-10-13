/**
 * Comments and reactions contract (docs/parity/m5.md, Step 0; owner:
 * Package C). Client-safe.
 */

export type CommentTargetType =
  | "segment"
  | "summary_item"
  | "action_item"
  | "clip"
  | "chapter"
  | "meeting"

export type ReactionTargetType = Exclude<CommentTargetType, "meeting"> | "comment"

/** Time anchor so a segment comment survives re-transcription. */
export type CommentAnchor = {
  startMs?: number
  quote?: string
}

export type MeetingComment = {
  id: string
  workspaceId: string
  meetingId: string
  targetType: CommentTargetType
  targetId: string
  /** One level deep. */
  parentId?: string
  authorUserId: string
  /** Plain text (at most 4000 chars); rendered escaped. */
  body: string
  /** Member user ids parsed from `@[name](user:<id>)`. */
  mentions: string[]
  anchor: CommentAnchor
  resolvedAt?: string
  resolvedByUserId?: string
  editedAt?: string
  deletedAt?: string
  createdAt: string
  /** The target no longer exists (shown with the anchor quote). */
  orphaned?: boolean
}

export type CommentThread = MeetingComment & { replies: MeetingComment[] }

export const REACTION_EMOJIS = ["\u{1F44D}", "❤️", "\u{1F3AF}", "✅", "❓", "\u{1F602}"] as const

export type ReactionEmoji = (typeof REACTION_EMOJIS)[number]

export type ReactionSummary = {
  targetType: ReactionTargetType
  targetId: string
  emoji: ReactionEmoji
  count: number
  /** The current user reacted with this emoji. */
  mine: boolean
}

export type CreateCommentInput = {
  targetType: CommentTargetType
  targetId: string
  parentId?: string
  body: string
  anchor?: CommentAnchor
}

export type CommentListResult = {
  /** Threads grouped by `${targetType}:${targetId}`. */
  threads: Record<string, CommentThread[]>
  reactions: ReactionSummary[]
}

/** Maximum comment body length. */
export const COMMENT_MAX_LENGTH = 4000
