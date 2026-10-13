/**
 * Notification reads for the bell (docs/parity/m9.md C1). A reader sees only
 * their own rows in the current workspace, plus `invited` rows from any
 * workspace. Each DTO is rebuilt at read time: the meeting is re-fetched
 * through the reader's scoped repository, so a meeting they can no longer see
 * gets `title: null` and an empty `href` (security check 4). Server-only.
 */
import { getCollabBackend, nowIso, toIso, type CollabBackend } from "@/lib/clips/db"
import { buildShellUrl } from "@/lib/client/shell-url"
import type { MeetingRepository } from "@/lib/meetings/repository"
import type { MemoryNotificationRow } from "@/lib/notifications/enqueue"
import { isNotificationKind, type NotificationDTO, type NotificationKind } from "@/lib/notifications/types"

export type NotificationReader = {
  userId: string
  workspaceId: string
  locale: string
  /** The reader's scoped repository (visibility re-check). */
  meetings: Pick<MeetingRepository, "getMeeting">
}

export type NotificationReadDeps = {
  backend?: CollabBackend
  /** Display names of the workspace's members (actor names). */
  listMemberNames?: (workspaceId: string) => Promise<Map<string, string>>
  /** Workspace names for `invited` rows. */
  getWorkspaceName?: (workspaceId: string) => Promise<string | undefined>
}

export type NotificationRow = {
  id: string
  workspaceId: string
  kind: NotificationKind
  payload: Record<string, unknown>
  meetingId?: string
  actorUserId?: string
  readAt?: string
  createdAt: string
}

export const NOTIFICATIONS_PAGE_MAX = 50

/** Payload keys a DTO may carry (ids and short codes only). */
const DTO_PAYLOAD_KEYS = new Set([
  "meetingId",
  "commentId",
  "parentId",
  "targetType",
  "targetId",
  "actionItemId",
  "clipId",
  "startMs",
  "connectionId",
  "provider",
  "invitationId",
  "workspaceId",
  "role",
  "transcriptVersion",
  "jobId",
  "sessionId",
  "reason",
])

export function encodeCursor(row: Pick<NotificationRow, "createdAt" | "id">): string {
  return Buffer.from(`${row.createdAt}|${row.id}`, "utf8").toString("base64url")
}

export function decodeCursor(cursor: string | null | undefined): { createdAt: string; id: string } | undefined {
  if (!cursor || cursor.length > 200) return undefined

  try {
    const [createdAt, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|")

    if (!createdAt || !id || Number.isNaN(Date.parse(createdAt)) || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) return undefined

    return { createdAt: new Date(createdAt).toISOString(), id }
  } catch {
    return undefined
  }
}

function mapRow(raw: Record<string, unknown>): NotificationRow | undefined {
  const kind = raw.kind

  if (!isNotificationKind(kind)) return undefined

  return {
    id: String(raw.id),
    workspaceId: String(raw.workspace_id),
    kind,
    payload: (raw.payload as Record<string, unknown> | null) ?? {},
    ...(raw.meeting_id ? { meetingId: String(raw.meeting_id) } : {}),
    ...(raw.actor_user_id ? { actorUserId: String(raw.actor_user_id) } : {}),
    ...(raw.read_at ? { readAt: toIso(raw.read_at) } : {}),
    createdAt: toIso(raw.created_at) ?? nowIso(),
  }
}

function memoryRows(backend: Extract<CollabBackend, { kind: "memory" }>, reader: Pick<NotificationReader, "userId" | "workspaceId">) {
  return (backend.db.notifications as MemoryNotificationRow[]).filter(
    (row) => row.userId === reader.userId && (row.workspaceId === reader.workspaceId || row.kind === "invited")
  )
}

function byNewest(a: { createdAt: string; id: string }, b: { createdAt: string; id: string }): number {
  return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
}

export async function listNotificationRows(
  reader: Pick<NotificationReader, "userId" | "workspaceId">,
  options: { cursor?: string | null; limit?: number; unread?: boolean },
  backend?: CollabBackend
): Promise<{ rows: NotificationRow[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 20) || 20, 1), NOTIFICATIONS_PAGE_MAX)
  const cursor = decodeCursor(options.cursor)
  const target = backend ?? (await getCollabBackend())
  let rows: NotificationRow[]

  if (target.kind === "memory") {
    rows = memoryRows(target, reader)
      .filter((row) => (options.unread ? !row.readAt : true))
      .filter((row) => !cursor || byNewest(row, cursor) > 0)
      .sort(byNewest)
      .slice(0, limit + 1)
      .flatMap((row) => {
        const mapped = mapRow({
          id: row.id,
          workspace_id: row.workspaceId,
          kind: row.kind,
          payload: row.payload,
          meeting_id: row.meetingId,
          actor_user_id: row.actorUserId,
          read_at: row.readAt,
          created_at: row.createdAt,
        })

        return mapped ? [mapped] : []
      })
  } else {
    const values: unknown[] = [reader.userId, reader.workspaceId]
    const clauses = ["n.user_id = $1", "(n.workspace_id = $2 or n.kind = 'invited')"]

    if (options.unread) clauses.push("n.read_at is null")
    if (cursor) {
      values.push(cursor.createdAt, cursor.id)
      clauses.push(`(n.created_at, n.id) < ($${values.length - 1}::timestamptz, $${values.length})`)
    }
    values.push(limit + 1)

    const result = await target.client.query(
      `select n.id, n.workspace_id, n.kind, n.payload, n.meeting_id, n.actor_user_id, n.read_at, n.created_at
       from notifications n
       where ${clauses.join(" and ")}
       order by n.created_at desc, n.id desc
       limit $${values.length}`,
      values
    )

    rows = (result.rows as Record<string, unknown>[]).flatMap((raw) => {
      const mapped = mapRow(raw)
      return mapped ? [mapped] : []
    })
  }

  const page = rows.slice(0, limit)
  const last = page[page.length - 1]

  return { rows: page, nextCursor: rows.length > limit && last ? encodeCursor(last) : null }
}

export async function countUnreadNotifications(
  reader: Pick<NotificationReader, "userId" | "workspaceId">,
  backend?: CollabBackend
): Promise<{ count: number; latestId: string | null }> {
  const target = backend ?? (await getCollabBackend())

  if (target.kind === "memory") {
    const unread = memoryRows(target, reader)
      .filter((row) => !row.readAt && isNotificationKind(row.kind))
      .sort(byNewest)

    return { count: unread.length, latestId: unread[0]?.id ?? null }
  }

  const result = await target.client.query(
    `select count(*)::int as count,
       (select n2.id from notifications n2
        where n2.user_id = $1 and (n2.workspace_id = $2 or n2.kind = 'invited') and n2.read_at is null
        order by n2.created_at desc, n2.id desc limit 1) as latest_id
     from notifications n
     where n.user_id = $1 and (n.workspace_id = $2 or n.kind = 'invited') and n.read_at is null`,
    [reader.userId, reader.workspaceId]
  )
  const row = result.rows[0] as { count?: number | string; latest_id?: string | null } | undefined

  return { count: Number(row?.count ?? 0), latestId: row?.latest_id ?? null }
}

/** Marks the reader's rows read; `ids` outside the reader's rows are ignored. */
export async function markNotificationsRead(
  reader: Pick<NotificationReader, "userId" | "workspaceId">,
  input: { ids: string[] } | { all: true },
  backend?: CollabBackend
): Promise<number> {
  const target = backend ?? (await getCollabBackend())
  const ids = "ids" in input ? input.ids.filter((id) => typeof id === "string" && id.length <= 80).slice(0, 200) : null

  if (ids && ids.length === 0) return 0

  if (target.kind === "memory") {
    const stamp = nowIso()
    let changed = 0

    for (const row of memoryRows(target, reader)) {
      if (row.readAt || (ids && !ids.includes(row.id))) continue
      row.readAt = stamp
      changed += 1
    }

    return changed
  }

  const values: unknown[] = [reader.userId, reader.workspaceId]
  let filter = ""

  if (ids) {
    values.push(ids)
    filter = " and id = any($3::text[])"
  }

  const result = await target.client.query(
    `update notifications set read_at = now(), seen_at = coalesce(seen_at, now())
     where user_id = $1 and (workspace_id = $2 or kind = 'invited') and read_at is null${filter}
     returning id`,
    values
  )

  return result.rows.length
}

async function defaultMemberNames(workspaceId: string): Promise<Map<string, string>> {
  const { getWorkspaceStore } = await import("@/lib/workspaces/store")
  const members = await getWorkspaceStore().listMembers(workspaceId)

  return new Map(members.map((member) => [member.userId, member.user.name?.trim() || member.user.email]))
}

async function defaultWorkspaceName(workspaceId: string): Promise<string | undefined> {
  const { getWorkspaceStore } = await import("@/lib/workspaces/store")

  return (await getWorkspaceStore().getWorkspace(workspaceId))?.name
}

function dtoPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).filter(([key]) => DTO_PAYLOAD_KEYS.has(key)))
}

/** Rebuilds DTOs with the visibility re-check and links (exported for tests). */
export async function toNotificationDTOs(
  reader: NotificationReader,
  rows: readonly NotificationRow[],
  deps: NotificationReadDeps = {}
): Promise<NotificationDTO[]> {
  const meetingIds = [
    ...new Set(
      rows
        .filter((row) => row.workspaceId === reader.workspaceId)
        .map((row) => row.meetingId ?? (typeof row.payload.meetingId === "string" ? row.payload.meetingId : undefined))
        .filter((id): id is string => Boolean(id))
    ),
  ]
  const visible = new Map<string, { title: string; language: string | null }>()

  await Promise.all(
    meetingIds.map(async (id) => {
      const meeting = await reader.meetings.getMeeting(id, { includeTranscript: false }).catch(() => undefined)

      if (meeting && (meeting.workspaceId ?? reader.workspaceId) === reader.workspaceId) {
        visible.set(id, { title: meeting.title, language: meeting.language ?? null })
      }
    })
  )

  const needsNames = rows.some((row) => row.actorUserId)
  const names = needsNames
    ? await (deps.listMemberNames ?? defaultMemberNames)(reader.workspaceId).catch(() => new Map<string, string>())
    : new Map<string, string>()
  const workspaceNames = new Map<string, string | undefined>()

  for (const row of rows) {
    const id = row.kind === "invited" && typeof row.payload.workspaceId === "string" ? row.payload.workspaceId : undefined

    if (id && !workspaceNames.has(id)) {
      workspaceNames.set(id, await (deps.getWorkspaceName ?? defaultWorkspaceName)(id).catch(() => undefined))
    }
  }

  return rows.map((row) => {
    const payload = dtoPayload(row.payload)
    const meetingId =
      row.workspaceId === reader.workspaceId
        ? row.meetingId ?? (typeof payload.meetingId === "string" ? payload.meetingId : undefined)
        : undefined
    const seen = meetingId ? visible.get(meetingId) : undefined
    const actorName = row.actorUserId ? names.get(row.actorUserId) : undefined
    let href = ""

    if (row.kind === "integration_reauth") {
      href = buildShellUrl(reader.locale, { panel: "settings", section: "integrations" })
    } else if (row.kind === "invited") {
      const invitationId = typeof payload.invitationId === "string" ? payload.invitationId : ""

      href = invitationId ? `/${reader.locale}/invite/accept?id=${encodeURIComponent(invitationId)}` : ""
      const workspaceName = workspaceNames.get(String(payload.workspaceId ?? ""))
      if (workspaceName) payload.workspaceName = workspaceName
    } else if (meetingId && seen) {
      const startMs = typeof payload.startMs === "number" ? payload.startMs : undefined

      href = buildShellUrl(reader.locale, {
        meeting: meetingId,
        ...(startMs !== undefined ? { t: Math.floor(startMs / 1000) } : {}),
      })
    }

    return {
      id: row.id,
      kind: row.kind,
      createdAt: row.createdAt,
      readAt: row.readAt ?? null,
      ...(meetingId
        ? { meeting: { id: meetingId, title: seen?.title ?? null, language: seen?.language ?? null } }
        : {}),
      ...(row.actorUserId && actorName ? { actor: { id: row.actorUserId, name: actorName } } : {}),
      payload,
      href,
    }
  })
}

export async function listNotifications(
  reader: NotificationReader,
  options: { cursor?: string | null; limit?: number; unread?: boolean },
  deps: NotificationReadDeps = {}
): Promise<{ notifications: NotificationDTO[]; nextCursor: string | null }> {
  const { rows, nextCursor } = await listNotificationRows(reader, options, deps.backend)

  return { notifications: await toNotificationDTOs(reader, rows, deps), nextCursor }
}
