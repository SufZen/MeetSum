/**
 * Notification contracts (M9 Step 0, docs/parity/m9.md item 6). Frozen after
 * Step 0 (owner: Package C, extendable through the orchestrator). Payloads
 * hold ids and short snapshots only, never comment text, summaries or titles;
 * the client renders each kind from the dictionary.
 */

export const NOTIFICATION_KINDS = [
  "mention",
  "reply",
  "task_assigned",
  "integration_reauth",
  "invited",
  "meeting_processed",
  "meeting_failed",
  "bot_blocked",
] as const

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]

export type MentionPayload = {
  meetingId: string
  commentId: string
  targetType?: string
  targetId?: string
  startMs?: number
}

export type ReplyPayload = MentionPayload & { parentId: string }

export type TaskAssignedPayload = { meetingId?: string; actionItemId: string }

export type IntegrationReauthPayload = { connectionId: string; provider: string }

export type InvitedPayload = { invitationId: string; workspaceId: string; workspaceName?: string; role?: string }

export type MeetingProcessedPayload = { meetingId: string; transcriptVersion: number }

export type MeetingFailedPayload = { meetingId: string; jobId: string }

export type BotBlockedPayload = { meetingId: string; sessionId: string; reason?: string }

export type NotificationPayloadByKind = {
  mention: MentionPayload
  reply: ReplyPayload
  task_assigned: TaskAssignedPayload
  integration_reauth: IntegrationReauthPayload
  invited: InvitedPayload
  meeting_processed: MeetingProcessedPayload
  meeting_failed: MeetingFailedPayload
  bot_blocked: BotBlockedPayload
}

export type NotificationPayload = {
  [K in NotificationKind]: { kind: K; payload: NotificationPayloadByKind[K] }
}[NotificationKind]

/** What `GET /api/notifications` returns per row (visibility re-checked at read). */
export type NotificationDTO = {
  id: string
  kind: NotificationKind
  createdAt: string
  readAt: string | null
  /** `title` is null when the reader can no longer see the meeting. */
  meeting?: { id: string; title: string | null; language: string | null }
  actor?: { id: string; name: string }
  payload: Record<string, unknown>
  /** Built with `buildShellUrl`; empty when the target is no longer visible. */
  href: string
}

export type NotificationPrefs = { muted: NotificationKind[] }

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = { muted: [] }

export function isNotificationKind(value: unknown): value is NotificationKind {
  return typeof value === "string" && (NOTIFICATION_KINDS as readonly string[]).includes(value)
}
