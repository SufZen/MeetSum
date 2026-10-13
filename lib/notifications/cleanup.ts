/**
 * Notification retention (docs/parity/m9.md C1): deletes read rows older
 * than `MEETSUM_NOTIFICATIONS_RETENTION_DAYS` (default 90). Unread rows are
 * kept (the enqueue cap bounds them). Called from the media-retention entry
 * point. Server-only.
 */
import type { Queryable } from "@/lib/db/client"

export const DEFAULT_NOTIFICATIONS_RETENTION_DAYS = 90

export function notificationsRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.MEETSUM_NOTIFICATIONS_RETENTION_DAYS)

  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 3650 ? parsed : DEFAULT_NOTIFICATIONS_RETENTION_DAYS
}

/** Returns the number of rows deleted (0 in a dry run, which only counts). */
export async function cleanupReadNotifications(
  db: Queryable,
  options: { execute: boolean; days?: number }
): Promise<{ days: number; matched: number; deleted: number }> {
  const days = options.days ?? notificationsRetentionDays()
  const where = `read_at is not null and read_at < now() - ($1::int * interval '1 day')`

  if (!options.execute) {
    const result = await db.query(`select count(*)::int as n from notifications where ${where}`, [days])

    return { days, matched: Number((result.rows[0] as { n?: number } | undefined)?.n ?? 0), deleted: 0 }
  }

  const result = await db.query(`delete from notifications where ${where} returning id`, [days])

  return { days, matched: result.rows.length, deleted: result.rows.length }
}
