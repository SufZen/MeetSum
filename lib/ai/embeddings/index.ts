/**
 * Embedding providers (docs/parity/m6.md, A4; owner: Package A): Gemini
 * `gemini-embedding-001` at 1536 dimensions by default, the deterministic
 * `hash` embedder for tests and the e2e, batching, retries, cost and the
 * per-principal query-embedding LRU.
 *
 * `MEETSUM_EMBEDDING_PROVIDER=auto|gemini|hash|none` (auto = Gemini when
 * configured; auto never picks `hash`). The active key `{model,
 * dimensions}` is validated (`^[a-z0-9._-]{1,64}$`, integer 1..2000)
 * because it is interpolated into SQL as a literal; an invalid key disables
 * the provider (search runs lexical) instead of reaching SQL.
 */
import { getEmbeddingConfig, isValidEmbeddingKey } from "@/lib/ai/embeddings/config"
import { createGeminiEmbeddingProvider, isGeminiEmbeddingConfigured } from "@/lib/ai/embeddings/gemini"
import { createHashEmbeddingProvider, isHashEmbeddingAllowed } from "@/lib/ai/embeddings/hash"
import {
  EmbeddingError,
  type EmbeddingBatchResult,
  type EmbeddingInput,
  type EmbeddingProvider,
  type EmbeddingTask,
} from "@/lib/ai/embeddings/types"
import { foldText } from "@/lib/search/hebrew-normalize"
import { formatEmbeddingKey, type EmbeddingKey } from "@/lib/search/types"

export * from "@/lib/ai/embeddings/types"

type Env = Record<string, string | undefined>

let providerOverride: EmbeddingProvider | null | undefined
let warnedInvalidKey = false

/**
 * Test hook: forces the provider returned by `getEmbeddingProvider`
 * (`null` = none); `undefined` restores env-based selection.
 */
export function setEmbeddingProviderForTesting(provider: EmbeddingProvider | null | undefined): void {
  providerOverride = provider
  resetEmbeddingQueryCacheForTesting()
}

export function getEmbeddingProvider(env: Env = process.env): EmbeddingProvider | null {
  if (providerOverride !== undefined) return providerOverride

  const config = getEmbeddingConfig(env)

  if (config.provider === "none") return null
  if (config.provider === "hash") {
    return isHashEmbeddingAllowed(env) ? createHashEmbeddingProvider() : null
  }
  if (!isGeminiEmbeddingConfigured(env)) return null
  if (!isValidEmbeddingKey({ model: config.model, dimensions: config.dimensions })) {
    if (!warnedInvalidKey) {
      warnedInvalidKey = true
      console.warn("[search] MEETSUM_EMBEDDING_MODEL/DIMENSIONS is invalid; embeddings disabled (lexical search)")
    }
    return null
  }

  return createGeminiEmbeddingProvider(config)
}

export function getActiveEmbeddingKey(env: Env = process.env): EmbeddingKey | null {
  return getEmbeddingProvider(env)?.key ?? null
}

/** Embeds chunk texts with `RETRIEVAL_DOCUMENT`; throws `EmbeddingError("config")` without a provider. */
export async function embedDocuments(
  inputs: EmbeddingInput[],
  opts: { workspaceId: string; meetingId?: string; jobId?: string; signal?: AbortSignal }
): Promise<EmbeddingBatchResult> {
  const provider = getEmbeddingProvider()

  if (!provider) throw new EmbeddingError("No embedding provider is configured", "config", false)

  return provider.embed(inputs, { task: "RETRIEVAL_DOCUMENT", signal: opts.signal })
}

const QUERY_CACHE_MAX = 500
const QUERY_CACHE_TTL_MS = 10 * 60 * 1000
const queryCache = new Map<string, { vector: number[]; expiresAt: number }>()

export function resetEmbeddingQueryCacheForTesting(): void {
  queryCache.clear()
}

/**
 * Cache key: `workspaceId|principalKey|model:dims|task|folded`. Nothing
 * derived from one principal's free text is ever served to another.
 */
export function embeddingQueryCacheKey(parts: {
  workspaceId: string
  principalKey: string
  key: EmbeddingKey
  task: EmbeddingTask
  folded: string
}): string {
  return [parts.workspaceId, parts.principalKey, formatEmbeddingKey(parts.key), parts.task, parts.folded].join("|")
}

/** Query vector for search/ask; null (lexical) without a provider or on any error. */
export async function embedQuery(
  text: string,
  opts: { task: EmbeddingTask; workspaceId: string; principalKey: string; signal?: AbortSignal }
): Promise<number[] | null> {
  try {
    const provider = getEmbeddingProvider()
    const folded = foldText(text).replace(/\s+/g, " ").trim()

    if (!provider || !folded) return null

    const cacheKey = embeddingQueryCacheKey({
      workspaceId: opts.workspaceId,
      principalKey: opts.principalKey,
      key: provider.key,
      task: opts.task,
      folded,
    })
    const now = Date.now()
    const cached = queryCache.get(cacheKey)

    if (cached && cached.expiresAt > now) {
      queryCache.delete(cacheKey)
      queryCache.set(cacheKey, cached)
      return cached.vector
    }

    const result = await provider.embed([{ text }], { task: opts.task, signal: opts.signal })
    const vector = result.vectors[0]

    if (!vector?.length) return null

    queryCache.delete(cacheKey)
    queryCache.set(cacheKey, { vector, expiresAt: now + QUERY_CACHE_TTL_MS })
    while (queryCache.size > QUERY_CACHE_MAX) {
      const oldest = queryCache.keys().next().value

      if (oldest === undefined) break
      queryCache.delete(oldest)
    }

    return vector
  } catch {
    return null
  }
}
