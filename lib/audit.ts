import { getDatabasePool } from "@/lib/db/client"

export type AuditAction =
  | "meeting.share.created"
  | "meeting.share.updated"
  | "webhook.subscription.created"
  | "webhook.subscription.updated"
  | "webhook.delivery.retried"
  | "webhook.test.sent"
  | "realizeos.export.queued"
  | "realizeos.export.sent"
  | "realizeos.export.failed"
  | "realizeos.export.retried"

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
