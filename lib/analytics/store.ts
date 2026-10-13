/**
 * `meeting_analytics` persistence (M5 D3). Postgres when
 * `MEETSUM_STORAGE=postgres`, otherwise an in-memory map. Reads and writes
 * join `meetings` with the M2 visibility predicate, so a scope never reads or
 * writes analytics of a meeting it cannot see.
 */
import type {
  MeetingAnalyticsMetrics,
  MeetingAnalyticsRecord,
  MeetingSentiment,
} from "@/lib/analytics/types"
import { getDatabasePool, type Queryable } from "@/lib/db/client"
import type { RepoScope } from "@/lib/meetings/repository"
import { meetingScopeSql } from "@/lib/meetings/scope-sql"

export type AnalyticsStoreDeps = {
  /** Postgres client; defaults to the pool when MEETSUM_STORAGE=postgres. */
  client?: Queryable
}

const memoryAnalytics = new Map<string, MeetingAnalyticsRecord>()

/** Test hook: clears the in-memory store. */
export function resetMemoryAnalytics() {
  memoryAnalytics.clear()
}

function resolveClient(deps: AnalyticsStoreDeps): Queryable | undefined {
  if (deps.client) return deps.client

  return process.env.MEETSUM_STORAGE === "postgres" ? getDatabasePool() : undefined
}

type AnalyticsRow = {
  meeting_id: string
  workspace_id: string
  version: number
  transcript_hash: string
  metrics: MeetingAnalyticsMetrics
  sentiment: MeetingSentiment | null
  sentiment_ai_run_id: string | null
  computed_at: string | Date
}

function fromRow(row: AnalyticsRow): MeetingAnalyticsRecord {
  return {
    meetingId: row.meeting_id,
    workspaceId: row.workspace_id,
    version: Number(row.version),
    transcriptHash: row.transcript_hash,
    metrics: row.metrics,
    sentiment: row.sentiment ?? undefined,
    sentimentAiRunId: row.sentiment_ai_run_id ?? undefined,
    computedAt: row.computed_at instanceof Date ? row.computed_at.toISOString() : String(row.computed_at),
  }
}

export async function getMeetingAnalytics(
  scope: RepoScope,
  meetingId: string,
  deps: AnalyticsStoreDeps = {}
): Promise<MeetingAnalyticsRecord | undefined> {
  const client = resolveClient(deps)

  if (!client) {
    const record = memoryAnalytics.get(meetingId)

    return record && record.workspaceId === scope.workspaceId ? structuredClone(record) : undefined
  }

  const values: unknown[] = [meetingId]
  const visible = meetingScopeSql(scope, "m", values)
  const result = await client.query(
    `select ma.* from meeting_analytics ma
       join meetings m on m.id = ma.meeting_id
      where ma.meeting_id = $1 and ma.workspace_id = m.workspace_id and ${visible}`,
    values
  )
  const row = result.rows[0] as AnalyticsRow | undefined

  return row ? fromRow(row) : undefined
}

/**
 * Inserts or replaces the analytics row of a visible meeting. `sentiment`
 * undefined keeps the stored sentiment (metrics-only refresh); `null` clears
 * it. Returns undefined when the meeting is not visible to the scope.
 */
export async function upsertMeetingAnalytics(
  scope: RepoScope,
  record: Omit<MeetingAnalyticsRecord, "computedAt" | "sentiment" | "sentimentAiRunId"> & {
    sentiment?: MeetingSentiment | null
    sentimentAiRunId?: string | null
  },
  deps: AnalyticsStoreDeps = {}
): Promise<MeetingAnalyticsRecord | undefined> {
  const client = resolveClient(deps)

  if (record.workspaceId !== scope.workspaceId) return undefined

  if (!client) {
    const existing = memoryAnalytics.get(record.meetingId)
    const keepSentiment = record.sentiment === undefined
    const next: MeetingAnalyticsRecord = {
      meetingId: record.meetingId,
      workspaceId: record.workspaceId,
      version: record.version,
      transcriptHash: record.transcriptHash,
      metrics: record.metrics,
      sentiment: keepSentiment ? existing?.sentiment : (record.sentiment ?? undefined),
      sentimentAiRunId: keepSentiment
        ? existing?.sentimentAiRunId
        : (record.sentimentAiRunId ?? undefined),
      computedAt: new Date().toISOString(),
    }

    memoryAnalytics.set(record.meetingId, structuredClone(next))
    return next
  }

  const keepSentiment = record.sentiment === undefined
  const values: unknown[] = [
    record.meetingId,
    record.version,
    record.transcriptHash,
    JSON.stringify(record.metrics),
    keepSentiment ? null : record.sentiment === null ? null : JSON.stringify(record.sentiment),
    keepSentiment ? null : (record.sentimentAiRunId ?? null),
  ]
  const visible = meetingScopeSql(scope, "m", values)
  const sentimentUpdate = keepSentiment
    ? ""
    : ", sentiment = excluded.sentiment, sentiment_ai_run_id = excluded.sentiment_ai_run_id"
  const result = await client.query(
    `insert into meeting_analytics
       (meeting_id, workspace_id, version, transcript_hash, metrics, sentiment, sentiment_ai_run_id, computed_at)
     select m.id, m.workspace_id, $2, $3, $4::jsonb, $5::jsonb, $6, now()
       from meetings m
      where m.id = $1 and ${visible}
     on conflict (meeting_id) do update
       set version = excluded.version,
           transcript_hash = excluded.transcript_hash,
           metrics = excluded.metrics,
           computed_at = excluded.computed_at${sentimentUpdate}
     returning *`,
    values
  )
  const row = result.rows[0] as AnalyticsRow | undefined

  return row ? fromRow(row) : undefined
}
