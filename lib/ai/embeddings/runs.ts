/**
 * `ai_runs` rows for document embedding (docs/parity/m6.md, A4): task
 * `embedding`, model `"<model>:<dims>"`, input tokens, cost and metadata
 * `{chunks, embedded, reused, batches, usageEstimated}` (no text). Failures
 * write a failed row. Query embeddings are not recorded per request.
 * Observability only: never throws.
 */
import { insertAiRun } from "@/lib/ai/llm/runs"
import type { EmbeddingProviderId } from "@/lib/ai/embeddings/types"
import { formatEmbeddingKey, type EmbeddingKey } from "@/lib/search/types"
import { getLogger } from "@/lib/log"

const log = getLogger({ component: "ai.embeddings" })

export type EmbeddingRunInput = {
  workspaceId: string
  meetingId?: string
  jobId?: string
  status: "completed" | "failed"
  provider: EmbeddingProviderId
  key: EmbeddingKey
  startedAt: number
  latencyMs?: number
  inputTokens: number
  costUsd: number | null
  metadata: {
    chunks: number
    embedded: number
    reused: number
    batches: number
    usageEstimated: boolean
    [extra: string]: unknown
  }
  error?: string
}

export async function recordEmbeddingRun(run: EmbeddingRunInput): Promise<string | undefined> {
  try {
    return await insertAiRun({
      workspaceId: run.workspaceId,
      meetingId: run.meetingId,
      jobId: run.jobId,
      task: "embedding",
      status: run.status,
      provider: run.provider,
      model: formatEmbeddingKey(run.key),
      startedAt: run.startedAt,
      latencyMs: run.latencyMs,
      costEstimate: run.costUsd,
      usage: { inputTokens: run.inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      metadata: run.metadata,
      error: run.error,
    })
  } catch (error) {
    log.warn({ errorName: error instanceof Error ? error.name : "unknown" }, "[search] embedding run not recorded")
    return undefined
  }
}
