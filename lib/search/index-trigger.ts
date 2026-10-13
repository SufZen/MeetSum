/**
 * Asks for a meeting to be re-indexed after anything indexed changes
 * (transcript, speakers, title, intelligence, action items, template,
 * participants, tags, rooms). docs/parity/m6.md, Step 0 item 6; real now,
 * owned by Package A afterwards.
 *
 * Marks `meetings.search_requested_at` and enqueues a debounced
 * `meeting.index` job with one BullMQ id per meeting, so a burst of edits
 * collapses into one run. It never throws: a failure is logged and the
 * index sweeper (`search.index.sweep`) catches up on stale meetings.
 *
 * Only the Postgres storage keeps a search index; with in-memory storage
 * (demo, tests) search runs on the fly and this is a no-op.
 */
import type { Queryable } from "@/lib/db/client"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"

export type ReindexReason =
  | "transcript"
  | "transcript.edited"
  | "speakers"
  | "renamed"
  | "intelligence"
  | "action_items"
  | "template"
  | "visibility"
  | "participants"
  | "tags"
  | "contexts"

export type RequestMeetingReindexInput = {
  workspaceId: string
  meetingId: string
  reason: ReindexReason
  /** Defaults to the shared pool. */
  db?: Queryable
}

const DEFAULT_DEBOUNCE_MS = 15_000

export function indexDebounceMs(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number(env.MEETSUM_INDEX_DEBOUNCE_MS)

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DEBOUNCE_MS
}

/**
 * BullMQ id of a meeting's pending index job. The spec's
 * `meeting.index:<id>` uses `-` because BullMQ rejects `:` in custom ids
 * (same convention as `mediaPrepareJobId`).
 */
export function meetingIndexJobId(meetingId: string): string {
  return `meeting.index-${meetingId.replace(/:/g, "_")}`
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.name || "Error" : "unknown error"
}

export async function requestMeetingReindex({
  workspaceId,
  meetingId,
  reason,
  db,
}: RequestMeetingReindexInput): Promise<void> {
  if (!workspaceId || !meetingId) return
  if (!db && process.env.MEETSUM_STORAGE !== "postgres") return

  try {
    const client = db ?? (await import("@/lib/db/client")).getDatabasePool()

    await client.query(
      "update meetings set search_requested_at = now() where id = $1 and workspace_id = $2",
      [meetingId, workspaceId]
    )
  } catch (error) {
    console.warn("[search] reindex mark failed", reason, describeFailure(error))
  }

  try {
    await enqueueMeetSumJob(
      "meeting.index",
      { meetingId, workspaceId, reason },
      { jobId: meetingIndexJobId(meetingId), delay: indexDebounceMs() }
    )
  } catch (error) {
    console.warn("[search] reindex enqueue failed", reason, describeFailure(error))
  }
}
