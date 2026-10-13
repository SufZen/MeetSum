import { getDatabasePool } from "@/lib/db/client"

export type AuditAction =
  | "meeting.created"
  | "meeting.processed"
  | "meeting.reprocessed"
  | "meeting.deleted"
  | "meeting.share.created"
  | "meeting.share.updated"
  | "meeting.share.revoked"
  | "meeting.share.accessed"
  | "meeting.export.markdown"
  | "meeting.export.pdf"
  | "meeting.export.docx"
  | "meeting.export.notion"
  | "room.created"
  | "room.meeting.added"
  | "webhook.subscription.created"
  | "webhook.subscription.updated"
  | "webhook.delivery.retried"
  | "webhook.test.sent"
  | "realizeos.export.queued"
  | "realizeos.export.sent"
  | "realizeos.export.failed"
  | "realizeos.export.retried"
  | "auth.session.created"
  | "auth.session.refreshed"
  | "admin.settings.updated"
  | "api_key.created"
  | "api_key.revoked"
  | "media.retention.deleted"
  | "backup.created"
  | "backup.restored"
  | "capture.zoom.recording"
  | "capture.teams.recording"
  | "workspace.created"
  | "workspace.updated"
  | "member.role_changed"
  | "member.removed"
  | "member.left"
  | "invitation.created"
  | "invitation.resent"
  | "invitation.revoked"
  | "invitation.accepted"
  | "meeting.visibility.changed"
  | "meeting.speaker.mapped"
  | "meeting.speaker.merged"
  | "meeting.speaker.suggested"
  | "asr.glossary.updated"
  | "auth.login.denied"
  | "meeting.renamed"
  | "meeting.transcript.edited"
  | "meeting.transcript.reverted"
  | "media.prepare.failed"
  | "bot.join_requested"
  | "bot.scheduled"
  | "bot.cancelled"
  | "bot.stop_requested"
  | "bot.rules.updated"
  | "bot.consent.acknowledged"
  | "template.created"
  | "template.updated"
  | "template.archived"
  | "meeting.template.changed"
  | "action_item.created"
  | "action_item.updated"
  | "action_item.deleted"
  | "clip.created"
  | "clip.updated"
  | "clip.deleted"
  | "clip.shared"
  | "comment.created"
  | "comment.deleted"
  | "comment.resolved"

export type RecordAuditLogInput = {
  action: AuditAction
  actor?: string
  targetType?: string
  targetId?: string
  metadata?: Record<string, unknown>
  /**
   * Workspace the event belongs to. `null` only for instance-level events
   * that belong to no workspace (e.g. a denied login); such rows are
   * invisible to every workspace's audit log.
   */
  workspaceId: string | null
  actorUserId?: string
  actorApiKeyId?: string
}

export async function recordAuditLog(input: RecordAuditLogInput) {
  if (process.env.MEETSUM_STORAGE !== "postgres") return

  await getDatabasePool().query(
    `
      insert into audit_logs (
        id, action, actor, target_type, target_id, metadata,
        workspace_id, actor_user_id, actor_api_key_id
      )
      values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
    `,
    [
      `audit_${crypto.randomUUID()}`,
      input.action,
      input.actor ?? null,
      input.targetType ?? null,
      input.targetId ?? null,
      JSON.stringify(input.metadata ?? {}),
      input.workspaceId ?? null,
      input.actorUserId ?? null,
      input.actorApiKeyId ?? null,
    ]
  )
}

export type AuditLogEntry = {
  id: string
  action: AuditAction
  actor?: string
  actorUserId?: string
  actorApiKeyId?: string
  workspaceId?: string
  targetType?: string
  targetId?: string
  metadata: Record<string, unknown>
  createdAt: string
}

export type ListAuditLogsOptions = {
  /** Workspace whose log is read (mandatory: logs are never cross-tenant). */
  workspaceId: string
  action?: AuditAction
  /** Matches the actor label, the actor user id or the actor API key id. */
  actor?: string
  targetType?: string
  targetId?: string
  /** `nextCursor` of a previous page (or an ISO timestamp). */
  before?: string
  limit?: number
}

export type AuditLogPage = {
  logs: AuditLogEntry[]
  /** Pass as `before` to read the next (older) page; absent on the last page. */
  nextCursor?: string
}

function normalizeAuditLimit(value?: number) {
  if (!value || !Number.isFinite(value)) return 50

  return Math.max(1, Math.min(Math.trunc(value), 200))
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value)
}

export function encodeAuditCursor(
  entry: Pick<AuditLogEntry, "id" | "createdAt">
): string {
  return Buffer.from(`${entry.createdAt}|${entry.id}`, "utf8").toString(
    "base64url"
  )
}

export function decodeAuditCursor(
  cursor: string
): { createdAt: string; id?: string } | undefined {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8")
  const separator = decoded.lastIndexOf("|")

  if (separator > 0) {
    const createdAt = decoded.slice(0, separator)
    const id = decoded.slice(separator + 1)

    if (!Number.isNaN(Date.parse(createdAt)) && id) return { createdAt, id }
  }

  return Number.isNaN(Date.parse(cursor)) ? undefined : { createdAt: cursor }
}

export class InvalidAuditCursorError extends Error {
  constructor() {
    super("Invalid audit log cursor")
    this.name = "InvalidAuditCursorError"
  }
}

/** Newest-first page of one workspace's audit log (keyset pagination). */
export async function listAuditLogsPage(
  options: ListAuditLogsOptions
): Promise<AuditLogPage> {
  if (process.env.MEETSUM_STORAGE !== "postgres") return { logs: [] }

  const limit = normalizeAuditLimit(options.limit)
  const values: unknown[] = []
  const param = (value: unknown) => {
    values.push(value)
    return `$${values.length}`
  }
  const conditions = [
    `workspace_id = ${param(options.workspaceId)}`,
  ]

  if (options.action) conditions.push(`action = ${param(options.action)}`)
  if (options.actor) {
    const actor = param(options.actor)

    conditions.push(
      `(actor = ${actor} or actor_user_id = ${actor} or actor_api_key_id = ${actor})`
    )
  }
  if (options.targetType) {
    conditions.push(`target_type = ${param(options.targetType)}`)
  }
  if (options.targetId) conditions.push(`target_id = ${param(options.targetId)}`)

  const cursor = options.before ? decodeAuditCursor(options.before) : undefined

  if (options.before && !cursor) throw new InvalidAuditCursorError()
  if (cursor?.id) {
    conditions.push(
      `(created_at, id) < (${param(cursor.createdAt)}::timestamptz, ${param(cursor.id)})`
    )
  } else if (cursor) {
    conditions.push(`created_at < ${param(cursor.createdAt)}::timestamptz`)
  }

  const result = await getDatabasePool().query(
    `
      select id, action, actor, actor_user_id, actor_api_key_id, workspace_id,
             target_type, target_id, metadata, created_at
      from audit_logs
      where ${conditions.join(" and ")}
      order by created_at desc, id desc
      limit ${param(limit + 1)}
    `,
    values
  )
  const rows = result.rows as Array<Record<string, unknown>>
  const logs: AuditLogEntry[] = rows.slice(0, limit).map((row) => ({
    id: String(row.id),
    action: String(row.action) as AuditAction,
    actor: row.actor ? String(row.actor) : undefined,
    actorUserId: row.actor_user_id ? String(row.actor_user_id) : undefined,
    actorApiKeyId: row.actor_api_key_id ? String(row.actor_api_key_id) : undefined,
    workspaceId: row.workspace_id ? String(row.workspace_id) : undefined,
    targetType: row.target_type ? String(row.target_type) : undefined,
    targetId: row.target_id ? String(row.target_id) : undefined,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: toIso(row.created_at),
  }))
  const last = logs.at(-1)

  return {
    logs,
    nextCursor: rows.length > limit && last ? encodeAuditCursor(last) : undefined,
  }
}

/** Newest-first entries of one workspace's audit log. */
export async function listAuditLogs(
  options: ListAuditLogsOptions
): Promise<AuditLogEntry[]> {
  return (await listAuditLogsPage(options)).logs
}
