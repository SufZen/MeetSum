/**
 * Durable AskMeetSum daily cap (docs/parity/m6.md, C7; M6 review).
 *
 * One atomic counter per `(workspace, principal, UTC day)`, reserved BEFORE
 * the LLM call: `insert … on conflict do update set count = count + 1 where
 * count < limit returning count`. No row back means the cap is reached.
 * Counts every ask — persisted or not, user or API key — across processes
 * and restarts, and parallel requests can't overshoot (no check-then-insert).
 *
 * Postgres (`ask_usage`, migration 026) when `MEETSUM_STORAGE=postgres`,
 * otherwise an in-process mirror (dev, demo, tests). A counter that can't be
 * written throws; the caller fails closed.
 */
import { getDatabasePool, type Queryable } from "@/lib/db/client"

export type AskUsageReservation = {
  workspaceId: string
  /** `user:<id>`, or `api_key:<id>` for a key without a creator. */
  principalKey: string
  /** UTC day, `YYYY-MM-DD`. */
  day: string
  /** Daily cap (>= 1). */
  limit: number
}

export type AskUsageCounter = {
  /** The new count when a slot was reserved, null when the cap is reached. Throws when the counter can't be written. */
  reserve(input: AskUsageReservation): Promise<number | null>
}

export function buildReserveAskUsageSql(input: AskUsageReservation): { text: string; values: unknown[] } {
  return {
    text:
      "insert into ask_usage (workspace_id, principal_key, day, count) values ($1, $2, $3::date, 1) " +
      "on conflict (workspace_id, principal_key, day) do update set count = ask_usage.count + 1, updated_at = now() " +
      "where ask_usage.count < $4 returning count",
    values: [input.workspaceId, input.principalKey, input.day, input.limit],
  }
}

export function createPgAskUsageCounter(db: Queryable): AskUsageCounter {
  return {
    async reserve(input) {
      const sql = buildReserveAskUsageSql(input)
      const row = (await db.query(sql.text, sql.values)).rows[0] as { count?: number | string } | undefined

      return row?.count === undefined ? null : Number(row.count)
    },
  }
}

const memoryCounts = new Map<string, number>()

export function resetMemoryAskUsageForTesting() {
  memoryCounts.clear()
}

/** In-process mirror of `ask_usage` (synchronous increment, so atomic within the process). */
export function createMemoryAskUsageCounter(counts: Map<string, number> = new Map()): AskUsageCounter {
  return {
    async reserve(input) {
      const key = `${input.workspaceId}|${input.principalKey}|${input.day}`
      const count = counts.get(key) ?? 0

      if (count >= input.limit) return null
      counts.set(key, count + 1)
      return count + 1
    },
  }
}

/** The process-wide counter: Postgres when `MEETSUM_STORAGE=postgres`, else the in-process mirror. */
export function getAskUsageCounter(): AskUsageCounter {
  return process.env.MEETSUM_STORAGE === "postgres"
    ? createPgAskUsageCounter(getDatabasePool())
    : createMemoryAskUsageCounter(memoryCounts)
}

export function usageDay(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}
