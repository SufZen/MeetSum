/**
 * Embedding providers (Gemini `gemini-embedding-001` at 1536 dimensions,
 * deterministic `hash` for tests), batching, retries, cost and the
 * per-principal query-embedding LRU (docs/parity/m6.md, A4; owner: Package A).
 *
 * STEP 0 STUB: no provider is configured; queries embed to null (lexical).
 */
import {
  EmbeddingError,
  type EmbeddingBatchResult,
  type EmbeddingInput,
  type EmbeddingProvider,
  type EmbeddingTask,
} from "@/lib/ai/embeddings/types"
import type { EmbeddingKey } from "@/lib/search/types"

export * from "@/lib/ai/embeddings/types"

type Env = Record<string, string | undefined>

export function getEmbeddingProvider(env: Env = process.env): EmbeddingProvider | null {
  void env

  return null
}

export function getActiveEmbeddingKey(env: Env = process.env): EmbeddingKey | null {
  void env

  return null
}

export async function embedDocuments(
  inputs: EmbeddingInput[],
  opts: { workspaceId: string; meetingId?: string; jobId?: string; signal?: AbortSignal }
): Promise<EmbeddingBatchResult> {
  void inputs
  void opts

  throw new EmbeddingError("No embedding provider is configured", "config", false)
}

export async function embedQuery(
  text: string,
  opts: { task: EmbeddingTask; workspaceId: string; principalKey: string; signal?: AbortSignal }
): Promise<number[] | null> {
  void text
  void opts

  return null
}
