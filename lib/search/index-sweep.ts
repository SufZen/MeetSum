/**
 * Index sweeper, backfill planning and admin status (docs/parity/m6.md,
 * A7; owner: Package A). All SQL is scoped by `workspace_id`.
 *
 * Sweeper (`search.index.sweep`, one job per workspace every
 * `MEETSUM_INDEX_SWEEP_EVERY_MS`): selects at most
 * `MEETSUM_INDEX_SWEEP_BATCH` usable meetings (a transcript or a summary)
 * that are stale, and enqueues their deduplicated `meeting.index` job:
 *   - `failed`: retried at most every 6 h (`search_indexed_at` records the
 *     last attempt);
 *   - otherwise: `pending`, `search_indexed_version` ≠ `transcript_version`,
 *     `search_requested_at` after the last index start, and, when vectors
 *     are possible, `ready` meetings that are `lexical` or carry another
 *     embedding key.
 */
import type { Queryable } from "@/lib/db/client"
import { formatEmbeddingKey, type EmbeddingKey } from "@/lib/search/types"

type Env = Record<string, string | undefined>

const DEFAULT_SWEEP_EVERY_MS = 600_000
const DEFAULT_SWEEP_BATCH = 50
const MAX_SWEEP_LIMIT = 1_000

export function indexSweepEveryMs(env: Env = process.env): number {
  const parsed = Number(env.MEETSUM_INDEX_SWEEP_EVERY_MS)

  return Number.isFinite(parsed) && parsed >= 10_000 ? parsed : DEFAULT_SWEEP_EVERY_MS
}

export function indexSweepBatch(env: Env = process.env): number {
  const parsed = Number(env.MEETSUM_INDEX_SWEEP_BATCH)

  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, MAX_SWEEP_LIMIT) : DEFAULT_SWEEP_BATCH
}

const USABLE_SQL = `(exists (select 1 from transcript_segments ts where ts.meeting_id = m.id)
    or exists (select 1 from summaries s where s.meeting_id = m.id))`

/**
 * Staleness predicate. `keyParam` is the placeholder of the active key
 * (`"<model>:<dims>"`) when vectors are possible; `retryWindow` limits
 * `failed` meetings to one attempt per 6 h (the sweeper; a backfill retries
 * them immediately).
 */
function staleSql(options: { keyParam?: string; retryWindow: boolean }): string {
  const vectorCatchUp = options.keyParam
    ? `
        or (m.search_index_state = 'ready'
          and (m.search_index_mode = 'lexical' or m.search_embedding_key is distinct from ${options.keyParam}))`
    : ""
  const failed = options.retryWindow
    ? "(m.search_index_state = 'failed' and coalesce(m.search_indexed_at, '-infinity'::timestamptz) < now() - interval '6 hours')"
    : "m.search_index_state = 'failed'"

  return `(
    ${failed}
    or (m.search_index_state <> 'failed' and (
      m.search_index_state = 'pending'
      or m.search_indexed_version is distinct from m.transcript_version
      or m.search_requested_at > coalesce(m.search_indexed_at, '-infinity'::timestamptz)${vectorCatchUp}
    ))
  )`
}

export type StaleMeeting = { meetingId: string; workspaceId: string }

export async function selectStaleMeetings(
  db: Queryable,
  options: { workspaceId: string; activeKey: EmbeddingKey | null; vectorCapable: boolean; limit: number }
): Promise<StaleMeeting[]> {
  const values: unknown[] = [options.workspaceId, Math.min(Math.max(1, Math.trunc(options.limit)), MAX_SWEEP_LIMIT)]
  let keyParam: string | undefined

  if (options.vectorCapable && options.activeKey) {
    values.push(formatEmbeddingKey(options.activeKey))
    keyParam = `$${values.length}`
  }

  const result = await db.query(
    `select m.id, m.workspace_id
     from meetings m
     where m.workspace_id = $1
       and ${USABLE_SQL}
       and ${staleSql({ keyParam, retryWindow: true })}
     order by coalesce(m.search_requested_at, m.started_at) desc
     limit $2`,
    values
  )

  return result.rows.map((row) => {
    const entry = row as { id: string; workspace_id: string }

    return { meetingId: entry.id, workspaceId: entry.workspace_id }
  })
}

export type SweepDeps = {
  db?: Queryable
  activeKey?: EmbeddingKey | null
  vectorCapable?: boolean
  enqueue?: (meeting: StaleMeeting) => Promise<void>
  log?: Pick<Console, "warn">
}

async function defaultDb(): Promise<Queryable> {
  return (await import("@/lib/db/client")).getDatabasePool()
}

/** Enqueues `meeting.index` for the workspace's stale meetings; never throws per meeting. */
export async function sweepWorkspaceIndex(
  workspaceId: string,
  options: { limit?: number } = {},
  deps: SweepDeps = {}
): Promise<{ selected: number; enqueued: number; failed: number }> {
  if (!deps.db && process.env.MEETSUM_STORAGE !== "postgres") return { selected: 0, enqueued: 0, failed: 0 }

  let activeKey = deps.activeKey
  let vectorCapable = deps.vectorCapable

  if (activeKey === undefined || vectorCapable === undefined) {
    const { getSearchCapabilities } = await import("@/lib/search/capabilities")
    const caps = await getSearchCapabilities()

    activeKey ??= caps.embeddingKey
    vectorCapable ??= caps.vector.tableReady && Boolean(caps.embeddingKey)
  }

  const db = deps.db ?? (await defaultDb())
  const enqueue =
    deps.enqueue ??
    (async (meeting: StaleMeeting) => {
      const { enqueueMeetingIndexJob } = await import("@/lib/search/index-trigger")

      await enqueueMeetingIndexJob({ ...meeting, reason: "sweep" })
    })
  const stale = await selectStaleMeetings(db, {
    workspaceId,
    activeKey,
    vectorCapable,
    limit: options.limit ?? indexSweepBatch(),
  })
  let enqueued = 0
  let failed = 0

  for (const meeting of stale) {
    try {
      await enqueue(meeting)
      enqueued += 1
    } catch (error) {
      failed += 1
      ;(deps.log ?? console).warn("[search] sweep enqueue failed", error instanceof Error ? error.name : "unknown")
    }
  }

  return { selected: stale.length, enqueued, failed }
}

/** Worker tick: one `search.index.sweep` job per live workspace. */
export async function enqueueIndexSweeps(
  deps: {
    db?: Queryable
    enqueue?: (workspaceId: string) => Promise<unknown>
    log?: Pick<Console, "warn">
  } = {}
): Promise<number> {
  if (!deps.db && process.env.MEETSUM_STORAGE !== "postgres") return 0

  const db = deps.db ?? (await defaultDb())
  const enqueue =
    deps.enqueue ??
    (async (workspaceId: string) => {
      const { enqueueMeetSumJob } = await import("@/lib/jobs/queue")

      return enqueueMeetSumJob("search.index.sweep", { workspaceId })
    })
  const result = await db.query("select id from workspaces where deleted_at is null order by created_at asc")
  let count = 0

  for (const row of result.rows) {
    try {
      await enqueue(String((row as { id: unknown }).id))
      count += 1
    } catch (error) {
      ;(deps.log ?? console).warn("[search] sweep schedule failed", error instanceof Error ? error.name : "unknown")
    }
  }

  return count
}

// ---------------------------------------------------------------------------
// Backfill (scripts/search-backfill.ts)

export type BackfillArgs = {
  workspaceId?: string
  all: boolean
  since?: string
  force: boolean
  inline: boolean
  concurrency: number
  dryRun: boolean
}

export function parseBackfillArgs(argv: string[]): BackfillArgs {
  const option = (name: string) => {
    const index = argv.indexOf(name)

    return index >= 0 ? argv[index + 1] : undefined
  }
  const workspaceId = option("--workspace")?.trim()
  const all = argv.includes("--all")
  const since = option("--since")?.trim()
  const concurrency = Number(option("--concurrency") ?? 2)

  if (!all && !workspaceId) throw new Error("Pass --workspace <id> or --all")
  if (all && workspaceId) throw new Error("Pass either --workspace <id> or --all, not both")
  if (since && Number.isNaN(Date.parse(since))) throw new Error(`Invalid --since date: ${since}`)

  return {
    ...(workspaceId ? { workspaceId } : {}),
    all,
    ...(since ? { since: new Date(since).toISOString() } : {}),
    force: argv.includes("--force"),
    inline: argv.includes("--inline"),
    concurrency: Number.isInteger(concurrency) && concurrency > 0 ? Math.min(concurrency, 8) : 2,
    dryRun: argv.includes("--dry-run"),
  }
}

export type BackfillCandidate = {
  meetingId: string
  workspaceId: string
  transcriptChars: number
  summaryChars: number
}

export async function selectBackfillMeetings(
  db: Queryable,
  options: { workspaceId?: string; since?: string; force: boolean; activeKey: EmbeddingKey | null; vectorCapable: boolean }
): Promise<BackfillCandidate[]> {
  const values: unknown[] = []
  const where = [USABLE_SQL]

  if (options.workspaceId) {
    values.push(options.workspaceId)
    where.unshift(`m.workspace_id = $${values.length}`)
  }
  if (options.since) {
    values.push(options.since)
    where.push(`m.started_at >= $${values.length}`)
  }
  if (!options.force) {
    let keyParam: string | undefined

    if (options.vectorCapable && options.activeKey) {
      values.push(formatEmbeddingKey(options.activeKey))
      keyParam = `$${values.length}`
    }
    where.push(staleSql({ keyParam, retryWindow: false }))
  }

  const result = await db.query(
    `select m.id, m.workspace_id,
       coalesce((select sum(length(ts.text)) from transcript_segments ts where ts.meeting_id = m.id), 0) as transcript_chars,
       coalesce((select length(s.overview) from summaries s where s.meeting_id = m.id order by s.created_at desc limit 1), 0) as summary_chars
     from meetings m
     where ${where.join("\n       and ")}
     order by m.started_at desc`,
    values
  )

  return result.rows.map((row) => {
    const entry = row as { id: string; workspace_id: string; transcript_chars: unknown; summary_chars: unknown }

    return {
      meetingId: entry.id,
      workspaceId: entry.workspace_id,
      transcriptChars: Number(entry.transcript_chars ?? 0),
      summaryChars: Number(entry.summary_chars ?? 0),
    }
  })
}

/** Overlap adds ~10% to transcript tokens (MEETSUM_CHUNK_OVERLAP_TOKENS / MAX). */
const OVERLAP_FACTOR = 1.1
/** Items, chapters and action items are roughly this many times the overview. */
const INTELLIGENCE_FACTOR = 4
const META_TOKENS = 100

/**
 * Embedding tokens and USD for indexing `candidates` from scratch (a
 * re-run reuses existing vectors and embeds far less). Tokens follow M5's
 * estimator (characters / 3).
 */
export function estimateBackfill(
  candidates: BackfillCandidate[],
  pricePerMTok: number
): { meetings: number; workspaces: number; tokens: number; usd: number } {
  const tokens = candidates.reduce(
    (sum, candidate) =>
      sum +
      Math.ceil((candidate.transcriptChars / 3) * OVERLAP_FACTOR) +
      Math.ceil(candidate.summaryChars / 3) * INTELLIGENCE_FACTOR +
      META_TOKENS,
    0
  )

  return {
    meetings: candidates.length,
    workspaces: new Set(candidates.map((candidate) => candidate.workspaceId)).size,
    tokens,
    usd: Math.round(((tokens * pricePerMTok) / 1e6) * 1e6) / 1e6,
  }
}

// ---------------------------------------------------------------------------
// Admin (app/api/admin/search/**)

export type IndexStatus = {
  counts: { state: string; mode: string | null; count: number }[]
  total: number
  activeKey: string | null
  activeKeyCoverage: { meetings: number; ready: number }
}

export async function getIndexStatus(db: Queryable, workspaceId: string, activeKey: EmbeddingKey | null): Promise<IndexStatus> {
  const key = activeKey ? formatEmbeddingKey(activeKey) : null
  const counts = await db.query(
    `select m.search_index_state as state, m.search_index_mode as mode, count(*)::int as count
     from meetings m
     where m.workspace_id = $1
     group by m.search_index_state, m.search_index_mode
     order by m.search_index_state, m.search_index_mode`,
    [workspaceId]
  )
  const coverage = await db.query(
    `select count(*) filter (where m.search_index_state = 'ready' and m.search_embedding_key = $2)::int as covered,
       count(*) filter (where m.search_index_state = 'ready')::int as ready
     from meetings m
     where m.workspace_id = $1`,
    [workspaceId, key]
  )
  const rows = counts.rows.map((row) => {
    const entry = row as { state: string; mode: string | null; count: unknown }

    return { state: entry.state, mode: entry.mode ?? null, count: Number(entry.count ?? 0) }
  })
  const covered = coverage.rows[0] as { covered?: unknown; ready?: unknown } | undefined

  return {
    counts: rows,
    total: rows.reduce((sum, row) => sum + row.count, 0),
    activeKey: key,
    activeKeyCoverage: { meetings: Number(covered?.covered ?? 0), ready: Number(covered?.ready ?? 0) },
  }
}

/** Marks every meeting of the workspace as requested; returns how many. */
export async function requestWorkspaceReindex(db: Queryable, workspaceId: string): Promise<number> {
  const result = await db.query(
    `with marked as (
       update meetings set search_requested_at = now() where workspace_id = $1 returning 1
     )
     select count(*)::int as count from marked`,
    [workspaceId]
  )

  return Number((result.rows[0] as { count?: unknown } | undefined)?.count ?? 0)
}

export const ADMIN_REINDEX_SWEEP_LIMIT = MAX_SWEEP_LIMIT
