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
 *
 * Ingest (`embedDocuments`) uses the full retry policy. Query-time
 * embedding (`embedQuery`: search, palette, Ask retrieval) has its own
 * budget (`MEETSUM_QUERY_EMBEDDING_*`) and a per-key circuit breaker, so a
 * 429 or an outage degrades search to lexical instead of hanging it.
 */
import {
  getEmbeddingConfig,
  getQueryEmbeddingConfig,
  isValidEmbeddingKey,
  type EmbeddingConfig,
} from "@/lib/ai/embeddings/config"
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
 * Test hook: forces the provider returned by `getEmbeddingProvider` and
 * used by `embedQuery` (`null` = none); `undefined` restores env-based
 * selection.
 */
export function setEmbeddingProviderForTesting(provider: EmbeddingProvider | null | undefined): void {
  providerOverride = provider
  resetEmbeddingQueryCacheForTesting()
}

/** The configured provider built with `config` (null without one or with an invalid key). */
function selectProvider(env: Env, config: EmbeddingConfig): EmbeddingProvider | null {
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

/** Ingest provider: the full retry policy (`MEETSUM_EMBEDDING_MAX_RETRIES` / `_TIMEOUT_MS`). */
export function getEmbeddingProvider(env: Env = process.env): EmbeddingProvider | null {
  if (providerOverride !== undefined) return providerOverride

  return selectProvider(env, getEmbeddingConfig(env))
}

/**
 * The embedding config for query-time calls: the same model and key, but
 * `MEETSUM_QUERY_EMBEDDING_MAX_RETRIES` (0-1) and a per-attempt timeout of
 * the query budget, never the ingest retry policy.
 */
export function queryEmbeddingProviderConfig(env: Env = process.env): EmbeddingConfig {
  const query = getQueryEmbeddingConfig(env)

  return { ...getEmbeddingConfig(env), maxRetries: query.maxRetries, timeoutMs: query.timeoutMs, concurrency: 1 }
}

/** Query-time provider (search, palette, Ask retrieval). */
function getQueryEmbeddingProvider(env: Env = process.env): EmbeddingProvider | null {
  if (providerOverride !== undefined) return providerOverride

  return selectProvider(env, queryEmbeddingProviderConfig(env))
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
/** Circuit breaker per embedding key (`<model>:<dims>`) → open until (epoch ms). */
const openCircuits = new Map<string, number>()

export function resetEmbeddingQueryCacheForTesting(): void {
  queryCache.clear()
  openCircuits.clear()
}

/** True while query embeddings for `key` are skipped after a recent failure. */
export function isQueryEmbeddingCircuitOpen(key: EmbeddingKey, now = Date.now()): boolean {
  const name = formatEmbeddingKey(key)
  const until = openCircuits.get(name)

  if (until === undefined) return false
  if (until > now) return true
  openCircuits.delete(name)
  return false
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

/** Settles with `promise`, or rejects as soon as `signal` aborts (even when the provider ignores it). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"))

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"))

    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      }
    )
  })
}

/**
 * Query vector for search/ask; null (lexical) without a provider, on any
 * error, when the budget (`MEETSUM_QUERY_EMBEDDING_TIMEOUT_MS`, default
 * 2.5 s for all attempts) runs out, when the caller's `signal` aborts
 * (client disconnect), or while the key's circuit is open. A provider
 * failure or a budget timeout opens the circuit for
 * `MEETSUM_QUERY_EMBEDDING_COOLDOWN_MS` (default 45 s); a caller abort does
 * not. Cached vectors are still served while the circuit is open.
 */
export async function embedQuery(
  text: string,
  opts: { task: EmbeddingTask; workspaceId: string; principalKey: string; signal?: AbortSignal }
): Promise<number[] | null> {
  let circuitKey: string | undefined

  try {
    if (opts.signal?.aborted) return null

    const provider = getQueryEmbeddingProvider()
    const folded = foldText(text).replace(/\s+/g, " ").trim()

    if (!provider || !folded) return null

    const cacheKey = embeddingQueryCacheKey({
      workspaceId: opts.workspaceId,
      principalKey: opts.principalKey,
      key: provider.key,
      task: opts.task,
      folded,
    })
    const cached = queryCache.get(cacheKey)

    if (cached && cached.expiresAt > Date.now()) {
      queryCache.delete(cacheKey)
      queryCache.set(cacheKey, cached)
      return cached.vector
    }
    if (isQueryEmbeddingCircuitOpen(provider.key)) return null

    circuitKey = formatEmbeddingKey(provider.key)

    const budget = getQueryEmbeddingConfig()
    const timeout = AbortSignal.timeout(budget.timeoutMs)
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
    const result = await untilAborted(provider.embed([{ text }], { task: opts.task, signal }), signal)
    const vector = result.vectors[0]

    if (!vector?.length) return null

    queryCache.delete(cacheKey)
    queryCache.set(cacheKey, { vector, expiresAt: Date.now() + QUERY_CACHE_TTL_MS })
    while (queryCache.size > QUERY_CACHE_MAX) {
      const oldest = queryCache.keys().next().value

      if (oldest === undefined) break
      queryCache.delete(oldest)
    }

    return vector
  } catch {
    if (circuitKey && !opts.signal?.aborted) {
      const { cooldownMs } = getQueryEmbeddingConfig()

      if (cooldownMs > 0) openCircuits.set(circuitKey, Date.now() + cooldownMs)
    }
    return null
  }
}
