import { getEmbeddingConfig } from "@/lib/ai/embeddings/config"
import { getDatabasePool } from "@/lib/db/client"
import { closeMeetSumQueue } from "@/lib/jobs/queue"
import { getSearchCapabilities } from "@/lib/search/capabilities"
import { enqueueMeetingIndexJob } from "@/lib/search/index-trigger"
import { indexMeeting } from "@/lib/search/indexer"
import { estimateBackfill, parseBackfillArgs, selectBackfillMeetings, type BackfillCandidate } from "@/lib/search/index-sweep"

/**
 * Builds the search index for existing meetings (M6, docs/parity/m6.md A7).
 *
 *   --workspace <id> | --all   which meetings (one of them is required)
 *   --since <date>             only meetings started on/after this date
 *   --force                    include meetings whose index is up to date
 *   --inline                   index in this process (no Redis), with
 *   --concurrency N            N meetings at a time (default 2)
 *   --dry-run                  print counts, estimated tokens and USD only
 *
 * Without --inline, each meeting gets its deduplicated `meeting.index` job
 * (needs Redis and a running worker). A re-run embeds only chunks whose
 * content changed. Output holds ids and counts only, never meeting text.
 */

async function runInline(candidates: BackfillCandidate[], concurrency: number) {
  const totals = { ready: 0, skipped: 0, failed: 0, chunks: 0, embedded: 0, reused: 0 }
  let next = 0

  async function worker() {
    while (next < candidates.length) {
      const candidate = candidates[next]

      next += 1
      try {
        const result = await indexMeeting({ workspaceId: candidate.workspaceId }, candidate.meetingId, { force: true })

        totals[result.state] += 1
        totals.chunks += result.chunks
        totals.embedded += result.embedded
        totals.reused += result.reused
      } catch (error) {
        totals.failed += 1
        console.warn(
          `[search] ${candidate.meetingId} failed:`,
          error instanceof Error ? error.name : "unknown error"
        )
      }
      const done = totals.ready + totals.skipped + totals.failed

      if (done % 25 === 0 || done === candidates.length) console.log(`[search] ${done}/${candidates.length} indexed`)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker))

  return totals
}

async function main() {
  const args = parseBackfillArgs(process.argv.slice(2))

  // The index lives in Postgres: this script always talks to DATABASE_URL.
  process.env.MEETSUM_STORAGE ??= "postgres"
  const db = getDatabasePool()
  const caps = await getSearchCapabilities({ refresh: true })
  const candidates = await selectBackfillMeetings(db, {
    workspaceId: args.workspaceId,
    since: args.since,
    force: args.force,
    activeKey: caps.embeddingKey,
    vectorCapable: caps.vector.tableReady && Boolean(caps.embeddingKey),
  })
  const plan = estimateBackfill(candidates, getEmbeddingConfig().pricePerMTok)
  const mode = caps.vector.tableReady && caps.embeddingKey ? "hybrid" : "lexical"

  console.log(
    JSON.stringify({ ...plan, mode, embeddingKey: caps.embeddingKey, note: "tokens/usd assume a fresh index" }, null, 2)
  )

  if (args.dryRun || !candidates.length) return

  if (args.inline) {
    console.log(JSON.stringify(await runInline(candidates, args.concurrency), null, 2))
    return
  }

  let enqueued = 0

  for (const candidate of candidates) {
    await enqueueMeetingIndexJob({ workspaceId: candidate.workspaceId, meetingId: candidate.meetingId, reason: "backfill" })
    enqueued += 1
  }
  console.log(`[search] enqueued ${enqueued} meeting.index jobs`)
}

main()
  .catch((error) => {
    console.error("[search] backfill failed:", error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(async () => {
    await closeMeetSumQueue().catch(() => undefined)
    if (process.env.DATABASE_URL) await getDatabasePool().end().catch(() => undefined)
  })
