/**
 * In-app notifications (`notifications` table; the inbox UI is M9). M5 only
 * writes rows: mentions and replies (comments) and task assignments (tasks).
 * Payloads carry ids only — never comment text or other content.
 * Server-only.
 */
import { getCollabBackend, nowIso, type CollabBackend } from "@/lib/clips/db"
import { createId } from "@/lib/workspaces/tokens"

export type NotificationKind = "mention" | "reply" | "task_assigned"

export type EnqueueNotificationInput = {
  workspaceId: string
  userId: string
  kind: NotificationKind
  payload: Record<string, unknown>
  /** Who caused it; a user is never notified about their own action. */
  actorUserId?: string
}

const KINDS: readonly NotificationKind[] = ["mention", "reply", "task_assigned"]
/** Payload keys that may be stored (ids, kinds, offsets). */
const PAYLOAD_KEYS = new Set([
  "meetingId",
  "commentId",
  "parentId",
  "targetType",
  "targetId",
  "actionItemId",
  "clipId",
  "actorUserId",
  "startMs",
])

function sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(payload).filter(
      ([key, value]) =>
        PAYLOAD_KEYS.has(key) &&
        (typeof value === "string" ? value.length <= 200 : typeof value === "number")
    )
  )
}

export async function enqueueNotification(
  input: EnqueueNotificationInput,
  backend?: CollabBackend
): Promise<{ id?: string; skipped: boolean }> {
  if (!input.workspaceId || !input.userId || !KINDS.includes(input.kind)) {
    return { skipped: true }
  }
  if (input.actorUserId && input.actorUserId === input.userId) return { skipped: true }

  const target = backend ?? (await getCollabBackend())
  const id = createId("ntf")
  const payload = sanitizePayload({
    ...input.payload,
    ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
  })

  if (target.kind === "memory") {
    target.db.notifications.push({
      id,
      workspaceId: input.workspaceId,
      userId: input.userId,
      kind: input.kind,
      payload,
      createdAt: nowIso(),
    })
    return { id, skipped: false }
  }

  // Only members of the workspace receive notifications.
  const result = await target.client.query(
    `
      insert into notifications (id, workspace_id, user_id, kind, payload)
      select $1, $2, $3, $4, $5::jsonb
      where exists (
        select 1 from memberships wm where wm.workspace_id = $2 and wm.user_id = $3
      )
      returning id
    `,
    [id, input.workspaceId, input.userId, input.kind, JSON.stringify(payload)]
  )

  return result.rows.length ? { id, skipped: false } : { skipped: true }
}
