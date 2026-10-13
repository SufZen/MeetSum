/**
 * In-app notifications (`notifications` table; M5 rows, M9 bell). Payloads
 * carry ids only, never comment text, titles or other content; the client
 * renders each kind from the dictionary.
 *
 * M9 (docs/parity/m9.md C1): never notifies the actor; respects the
 * recipient's `preferences.notifications.muted`; dedupes on
 * `(user_id, dedupe_key)`; keeps at most 200 unread per user (older ones are
 * marked read); writes `meeting_id` and `actor_user_id`. Server-only.
 */
import { getCollabBackend, nowIso, type CollabBackend, type StoredNotification } from "@/lib/clips/db"
import { getUserPreferences } from "@/lib/users/preferences"
import { createId } from "@/lib/workspaces/tokens"

import { isNotificationKind, type NotificationKind } from "@/lib/notifications/types"

export type { NotificationKind } from "@/lib/notifications/types"

export type EnqueueNotificationInput = {
  workspaceId: string
  userId: string
  kind: NotificationKind
  payload: Record<string, unknown>
  /** Who caused it; a user is never notified about their own action. */
  actorUserId?: string
  /** Defaults to a per-kind key derived from the payload (see `defaultDedupeKey`). */
  dedupeKey?: string
  /** Defaults to `payload.meetingId`. */
  meetingId?: string
}

/** Unread rows kept per user; older unread rows are marked read. */
export const MAX_UNREAD_PER_USER = 200

/** In-memory rows carry the M9 columns too (`lib/clips/db.ts` keeps the M5 shape). */
export type MemoryNotificationRow = StoredNotification & {
  meetingId?: string
  actorUserId?: string
  dedupeKey?: string
  seenAt?: string
}

/** Payload keys that may be stored (ids, kinds, offsets, short codes). */
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
  // M8 integration_reauth: which connection needs reconnecting (ids only).
  "connectionId",
  "provider",
  // M9 kinds.
  "invitationId",
  "workspaceId",
  "role",
  "transcriptVersion",
  "jobId",
  "sessionId",
  "reason",
  // share_attempts: which link and how many failures (never password data).
  "shareId",
  "failures",
])

const SHORT_CODE = /^[A-Za-z0-9_.:-]{1,64}$/

function sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(payload).filter(([key, value]) => {
      if (!PAYLOAD_KEYS.has(key)) return false
      if (key === "reason" || key === "role" || key === "provider") {
        return typeof value === "string" && SHORT_CODE.test(value)
      }

      return typeof value === "string" ? value.length <= 200 : typeof value === "number" && Number.isFinite(value)
    })
  )
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10)
}

/**
 * Dedupe keys of the M5/M8 kinds (their callers pass none). M9 producers
 * pass theirs explicitly: `mp:`, `mf:`, `inv:`, `bb:`.
 */
export function defaultDedupeKey(
  kind: NotificationKind,
  payload: Record<string, unknown>,
  now: Date = new Date()
): string | undefined {
  switch (kind) {
    case "mention": {
      const id = str(payload.commentId)
      return id ? `mn:${id}` : undefined
    }
    case "reply": {
      const id = str(payload.commentId)
      return id ? `rp:${id}` : undefined
    }
    case "task_assigned": {
      const id = str(payload.actionItemId)
      return id ? `ta:${id}:${utcDay(now)}` : undefined
    }
    case "integration_reauth": {
      const id = str(payload.connectionId)
      return id ? `ir:${id}:${utcDay(now)}` : undefined
    }
    case "meeting_processed": {
      const id = str(payload.meetingId)
      return id ? `mp:${id}:${Number(payload.transcriptVersion ?? 0)}` : undefined
    }
    case "meeting_failed": {
      const id = str(payload.meetingId)
      const job = str(payload.jobId)
      return id && job ? `mf:${id}:${job}` : undefined
    }
    case "invited": {
      const id = str(payload.invitationId)
      return id ? `inv:${id}` : undefined
    }
    case "bot_blocked": {
      const id = str(payload.sessionId)
      return id ? `bb:${id}` : undefined
    }
    case "share_attempts": {
      const id = str(payload.shareId)
      return id ? `sa:${id}:${utcDay(now)}` : undefined
    }
  }
}

async function isMutedInMemory(userId: string, kind: NotificationKind): Promise<boolean> {
  try {
    const prefs = await getUserPreferences(userId)

    return prefs.notifications.muted.includes(kind)
  } catch {
    return false
  }
}

export async function enqueueNotification(
  input: EnqueueNotificationInput,
  backend?: CollabBackend
): Promise<{ id?: string; skipped: boolean }> {
  if (!input.workspaceId || !input.userId || !isNotificationKind(input.kind)) {
    return { skipped: true }
  }

  // M5 tasks pass the assigner as `assignedByUserId`; treat it as the actor.
  const actorUserId = input.actorUserId ?? str(input.payload.assignedByUserId)

  if (actorUserId && actorUserId === input.userId) return { skipped: true }

  const target = backend ?? (await getCollabBackend())
  const id = createId("ntf")
  const payload = sanitizePayload({
    ...input.payload,
    ...(actorUserId ? { actorUserId } : {}),
  })
  const meetingId = input.meetingId ?? str(payload.meetingId)
  const dedupeKey = input.dedupeKey ?? defaultDedupeKey(input.kind, payload)

  if (target.kind === "memory") {
    const rows = target.db.notifications as MemoryNotificationRow[]

    if (dedupeKey && rows.some((row) => row.userId === input.userId && row.dedupeKey === dedupeKey)) {
      return { skipped: true }
    }
    if (await isMutedInMemory(input.userId, input.kind)) return { skipped: true }

    const row: MemoryNotificationRow = {
      id,
      workspaceId: input.workspaceId,
      userId: input.userId,
      kind: input.kind,
      payload,
      createdAt: nowIso(),
      ...(meetingId ? { meetingId } : {}),
      ...(actorUserId ? { actorUserId } : {}),
      ...(dedupeKey ? { dedupeKey } : {}),
    }

    rows.push(row)

    const unread = rows
      .filter((candidate) => candidate.userId === input.userId && !candidate.readAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))

    for (const stale of unread.slice(MAX_UNREAD_PER_USER)) stale.readAt = nowIso()

    return { id, skipped: false }
  }

  // One statement: recipients must be active users; every kind except
  // `invited` (the invitee is not a member yet) also requires a membership of
  // the workspace; muted kinds (users.preferences.notifications.muted) are
  // skipped; then unread rows beyond the cap are marked read (the CTE sees the
  // rows before the insert, so the new row counts as the newest).
  const membership =
    input.kind === "invited"
      ? "where"
      : `where exists (
        select 1 from memberships wm where wm.workspace_id = $2 and wm.user_id = $3
      )
        and`
  const result = await target.client.query(
    `
      with inserted as (
        insert into notifications (id, workspace_id, user_id, kind, payload, meeting_id, actor_user_id, dedupe_key)
        select $1, $2, u.id, $4, $5::jsonb,
          (select m.id from meetings m where m.id = $6 and m.workspace_id = $2),
          (select a.id from users a where a.id = $7),
          $8
        from users u
        ${membership} u.id = $3
          and u.disabled_at is null
          and not (coalesce(u.preferences #> '{notifications,muted}', '[]'::jsonb) ? $4)
        on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing
        returning id
      ),
      capped as (
        update notifications set read_at = now()
        where exists (select 1 from inserted)
          and id in (
            select n.id from notifications n
            where n.user_id = $3 and n.read_at is null
            order by n.created_at desc, n.id desc
            offset ${MAX_UNREAD_PER_USER - 1}
          )
        returning id
      )
      select id from inserted
    `,
    [id, input.workspaceId, input.userId, input.kind, JSON.stringify(payload), meetingId ?? null, actorUserId ?? null, dedupeKey ?? null]
  )

  if (!result.rows.length) return { skipped: true }

  return { id, skipped: false }
}

/**
 * M8 (Package A): tells a connection's creator that it needs reconnecting.
 * Ids only (connection id and provider); never a token or provider message.
 */
export async function enqueueIntegrationReauthNotification(
  input: { workspaceId: string; userId: string; connectionId: string; provider: string },
  backend?: CollabBackend
): Promise<{ id?: string; skipped: boolean }> {
  return enqueueNotification(
    {
      workspaceId: input.workspaceId,
      userId: input.userId,
      kind: "integration_reauth",
      payload: { connectionId: input.connectionId, provider: input.provider },
    },
    backend
  )
}
