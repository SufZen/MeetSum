/**
 * Meeting indexer (docs/parity/m6.md, A6; owner: Package A): chunk, hash,
 * embed only the chunks whose content changed, write chunks and vectors in
 * one transaction and set the meeting's search-index state. System scope,
 * workspace-checked: the meeting is loaded through the workspace's system
 * repository and every statement is scoped by `workspace_id`.
 *
 *   1. Load the meeting (segments, speakers, intelligence, action items,
 *      participants, tags, rooms, transcript_version).
 *   2. No transcript and no intelligence → `skipped` (a clean no-op).
 *   3. Build transcript chunks (A2) plus intelligence/meta chunks (A3).
 *   4. With an embeddings table and a provider: embed the hashes that have
 *      no vector for the active key (`RETRIEVAL_DOCUMENT`, title = meeting
 *      title). On failure, continue lexically when some vectors exist or
 *      none were needed; otherwise mark `failed` and throw (BullMQ retries).
 *   5. One transaction (index-store.ts); a transcript change meanwhile
 *      throws `IndexVersionConflictError` (retryable).
 *   6. `recordEmbeddingRun` when anything was sent to the provider.
 *
 * Only Postgres keeps a search index: with other storage this is a no-op.
 */
import { getEmbeddingProvider, type EmbeddingProvider } from "@/lib/ai/embeddings"
import { getEmbeddingConfig } from "@/lib/ai/embeddings/config"
import { recordEmbeddingRun, type EmbeddingRunInput } from "@/lib/ai/embeddings/runs"
import { EmbeddingError } from "@/lib/ai/embeddings/types"
import type { Queryable } from "@/lib/db/client"
import type { MeetingRecord } from "@/lib/meetings/repository"
import { getSearchCapabilities } from "@/lib/search/capabilities"
import { chunkTranscript } from "@/lib/search/chunker"
import { buildChunkSources } from "@/lib/search/chunk-sources"
import {
  createIndexStore,
  IndexMeetingMissingError,
  type IndexStore,
  type IndexVector,
} from "@/lib/search/index-store"
import type { ChunkDraft, SearchCapabilities } from "@/lib/search/types"

export type IndexMeetingResult = {
  state: "ready" | "skipped" | "failed"
  mode?: "hybrid" | "lexical"
  chunks: number
  embedded: number
  reused: number
}

export type IndexMeetingOptions = {
  /** Accepted for callers that re-index on demand; chunks are always rebuilt. */
  force?: boolean
  signal?: AbortSignal
  jobId?: string
}

export type IndexerDeps = {
  loadMeeting(workspaceId: string, meetingId: string): Promise<MeetingRecord | undefined>
  store: IndexStore
  capabilities(): Promise<SearchCapabilities>
  provider(): EmbeddingProvider | null
  recordRun(run: EmbeddingRunInput): Promise<unknown>
  now?: () => Date
}

/** Embedding failed and nothing usable exists: the job should retry. */
export class IndexEmbeddingFailedError extends Error {
  readonly retryable = true

  constructor(readonly cause: unknown) {
    super(`Embedding failed: ${describe(cause)}`)
    this.name = "IndexEmbeddingFailedError"
  }
}

function describe(error: unknown): string {
  if (error instanceof EmbeddingError) return `${error.kind}: ${error.message}`

  return error instanceof Error ? error.message : "unknown error"
}

function hasSomethingToIndex(meeting: MeetingRecord): boolean {
  return Boolean(meeting.transcript?.length || meeting.intelligence || meeting.summary?.overview?.trim())
}

export function buildMeetingChunks(meeting: MeetingRecord): ChunkDraft[] {
  return [
    ...chunkTranscript({
      segments: meeting.transcript ?? [],
      speakers: meeting.speakers ?? [],
      meetingLanguage: meeting.language,
    }),
    ...buildChunkSources(meeting),
  ]
}

export function createIndexer(deps: IndexerDeps) {
  return async function indexMeetingWith(
    scope: { workspaceId: string },
    meetingId: string,
    opts: IndexMeetingOptions = {}
  ): Promise<IndexMeetingResult> {
    const startedAt = deps.now?.() ?? new Date()
    const meeting = await deps.loadMeeting(scope.workspaceId, meetingId)

    if (!meeting || (meeting.workspaceId && meeting.workspaceId !== scope.workspaceId)) {
      return { state: "skipped", chunks: 0, embedded: 0, reused: 0 }
    }

    if (!hasSomethingToIndex(meeting)) {
      await deps.store.markSkipped(scope.workspaceId, meeting.id)
      return { state: "skipped", chunks: 0, embedded: 0, reused: 0 }
    }

    const chunks = buildMeetingChunks(meeting)
    const capabilities = await deps.capabilities()
    const provider = deps.provider()
    const key = provider?.key ?? null
    const vectorTable = capabilities.vector.tableReady
    const hashes = [...new Set(chunks.map((chunk) => chunk.contentHash))]
    let vectors: IndexVector[] = []
    let covered = 0
    let embedded = 0
    let reused = 0

    if (provider && key && vectorTable) {
      const existing = await deps.store.existingHashes(scope.workspaceId, meeting.id, key)
      const misses = hashes.filter((hash) => !existing.has(hash))
      const textOf = new Map(chunks.map((chunk) => [chunk.contentHash, chunk.text]))
      const runBase = {
        workspaceId: scope.workspaceId,
        meetingId: meeting.id,
        jobId: opts.jobId,
        provider: provider.id,
        key,
      }

      covered = hashes.length - misses.length
      reused = covered

      if (misses.length) {
        const embedStartedAt = Date.now()

        try {
          const result = await provider.embed(
            misses.map((hash) => ({ text: textOf.get(hash) ?? "", title: meeting.title })),
            { task: "RETRIEVAL_DOCUMENT", signal: opts.signal }
          )

          if (result.vectors.length !== misses.length) {
            throw new EmbeddingError("Embedding count does not match the input", "server", false)
          }
          vectors = misses.map((contentHash, index) => ({ contentHash, embedding: result.vectors[index] }))
          embedded = vectors.length
          covered += embedded
          await deps.recordRun({
            ...runBase,
            status: "completed",
            startedAt: embedStartedAt,
            latencyMs: result.latencyMs,
            inputTokens: result.usage.inputTokens,
            costUsd: result.costUsd,
            metadata: {
              chunks: chunks.length,
              embedded,
              reused,
              batches: Math.ceil(misses.length / getEmbeddingConfig().batchSize),
              attempts: result.attempts,
              usageEstimated: result.usage.estimated,
            },
          })
        } catch (error) {
          await deps.recordRun({
            ...runBase,
            status: "failed",
            startedAt: embedStartedAt,
            inputTokens: 0,
            costUsd: null,
            metadata: {
              chunks: chunks.length,
              embedded: 0,
              reused,
              batches: 0,
              usageEstimated: true,
            },
            error: describe(error),
          })

          if (covered === 0) {
            await deps.store.markFailed(scope.workspaceId, meeting.id, describe(error)).catch(() => undefined)
            throw new IndexEmbeddingFailedError(error)
          }
          // Some vectors exist: index now, the misses stay lexical and the
          // sweeper retries (mode `lexical` while vectors are possible).
        }
      }
    }

    const coversAllChunks = Boolean(provider && key && vectorTable && covered === hashes.length)
    const mode = coversAllChunks ? "hybrid" : "lexical"

    try {
      await deps.store.writeIndex({
        workspaceId: scope.workspaceId,
        meetingId: meeting.id,
        expectedVersion: meeting.transcriptVersion ?? 0,
        chunks,
        key,
        vectorTable,
        vectors,
        coversAllChunks,
        mode,
        meetingType: meeting.intelligence?.meetingType?.trim() || null,
        startedAt,
      })
    } catch (error) {
      if (error instanceof IndexMeetingMissingError) return { state: "skipped", chunks: 0, embedded, reused: 0 }
      throw error
    }

    return {
      state: "ready",
      mode,
      chunks: chunks.length,
      embedded,
      reused,
    }
  }
}

async function defaultDb(): Promise<Queryable> {
  return (await import("@/lib/db/client")).getDatabasePool()
}

export function defaultIndexerDeps(db: Queryable): IndexerDeps {
  return {
    loadMeeting: async (workspaceId, meetingId) => {
      const { getSystemMeetingRepository } = await import("@/lib/meetings/store")

      return getSystemMeetingRepository(workspaceId).getMeeting(meetingId)
    },
    store: createIndexStore(db),
    capabilities: () => getSearchCapabilities(),
    provider: () => getEmbeddingProvider(),
    recordRun: recordEmbeddingRun,
  }
}

export async function indexMeeting(
  scope: { workspaceId: string },
  meetingId: string,
  opts: IndexMeetingOptions = {}
): Promise<IndexMeetingResult> {
  if (process.env.MEETSUM_STORAGE !== "postgres") {
    return { state: "skipped", chunks: 0, embedded: 0, reused: 0 }
  }

  return createIndexer(defaultIndexerDeps(await defaultDb()))(scope, meetingId, opts)
}
