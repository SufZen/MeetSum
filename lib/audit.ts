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

export async function recordAuditLog(input: {
  action: AuditAction
  actor?: string
  targetType?: string
  targetId?: string
  metadata?: Record<string, unknown>
}) {
  if (process.env.MEETSUM_STORAGE !== "postgres") return

  await getDatabasePool().query(
    `
      insert into audit_logs (
        id, action, actor, target_type, target_id, metadata
      )
      values ($1, $2, $3, $4, $5, $6::jsonb)
    `,
    [
      `audit_${crypto.randomUUID()}`,
      input.action,
      input.actor ?? null,
      input.targetType ?? null,
      input.targetId ?? null,
      JSON.stringify(input.metadata ?? {}),
    ]
  )
}

export type AuditLogEntry = {
  id: string
  action: AuditAction
  actor?: string
  targetType?: string
  targetId?: string
  metadata: Record<string, unknown>
  createdAt: string
}

export async function listAuditLogs(options: {
  limit?: number
  action?: AuditAction
  targetType?: string
  targetId?: string
} = {}): Promise<AuditLogEntry[]> {
  if (process.env.MEETSUM_STORAGE !== "postgres") return []

  const limit = Math.min(options.limit ?? 50, 200)
  const conditions: string[] = []
  const values: unknown[] = []
  let paramIndex = 1

  if (options.action) {
    conditions.push(`action = $${paramIndex++}`)
    values.push(options.action)
  }
  if (options.targetType) {
    conditions.push(`target_type = $${paramIndex++}`)
    values.push(options.targetType)
  }
  if (options.targetId) {
    conditions.push(`target_id = $${paramIndex++}`)
    values.push(options.targetId)
  }

  const where = conditions.length ? `where ${conditions.join(" and ")}` : ""
  values.push(limit)

  const result = await getDatabasePool().query(
    `select * from audit_logs ${where} order by created_at desc limit $${paramIndex}`,
    values
  )

  return result.rows.map((row: Record<string, unknown>) => ({
    id: String(row.id),
    action: String(row.action) as AuditAction,
    actor: row.actor ? String(row.actor) : undefined,
    targetType: row.target_type ? String(row.target_type) : undefined,
    targetId: row.target_id ? String(row.target_id) : undefined,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: String(row.created_at),
  }))
}
