/**
 * M6 embedding contracts (docs/parity/m6.md, "Shared contracts"; Step 0).
 * Frozen after Step 0: changes go through the orchestrator.
 */
import type { EmbeddingKey } from "@/lib/search/types"

export type EmbeddingTask = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY" | "QUESTION_ANSWERING"

export type EmbeddingProviderId = "gemini" | "hash"

export type EmbeddingInput = { text: string; title?: string }

export type EmbeddingBatchResult = {
  vectors: number[][]
  key: EmbeddingKey
  usage: { inputTokens: number; estimated: boolean }
  costUsd: number | null
  latencyMs: number
  attempts: number
}

export type EmbeddingErrorKind =
  | "config"
  | "auth"
  | "rate_limit"
  | "timeout"
  | "server"
  | "bad_request"
  | "unknown"

export class EmbeddingError extends Error {
  constructor(
    m: string,
    readonly kind: EmbeddingErrorKind,
    readonly retryable: boolean
  ) {
    super(m)
    this.name = "EmbeddingError"
  }
}

export type EmbeddingProvider = {
  id: EmbeddingProviderId
  key: EmbeddingKey
  isConfigured(env?: Record<string, string | undefined>): boolean
  embed(
    inputs: EmbeddingInput[],
    opts: { task: EmbeddingTask; signal?: AbortSignal }
  ): Promise<EmbeddingBatchResult>
}
