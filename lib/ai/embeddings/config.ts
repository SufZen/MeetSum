/**
 * Embedding configuration from env (docs/parity/m6.md, A4 and "Env").
 *
 * The model and dimensions are interpolated into SQL as literals (so the
 * partial HNSW index matches), hence the strict validation here and again
 * at every SQL call site.
 */
import { EmbeddingError } from "@/lib/ai/embeddings/types"
import type { EmbeddingKey } from "@/lib/search/types"

type Env = Record<string, string | undefined>

export type EmbeddingProviderMode = "auto" | "gemini" | "hash" | "none"

export type EmbeddingConfig = {
  provider: EmbeddingProviderMode
  model: string
  dimensions: number
  batchSize: number
  concurrency: number
  maxRetries: number
  timeoutMs: number
  pricePerMTok: number
}

export const DEFAULT_EMBEDDING_MODEL = "gemini-embedding-001"
export const DEFAULT_EMBEDDING_DIMENSIONS = 1536
export const MAX_EMBEDDING_DIMENSIONS = 2000
export const EMBEDDING_MODEL_PATTERN = /^[a-z0-9._-]{1,64}$/

export function isValidEmbeddingKey(key: { model?: unknown; dimensions?: unknown } | null | undefined): key is EmbeddingKey {
  return (
    !!key &&
    typeof key.model === "string" &&
    EMBEDDING_MODEL_PATTERN.test(key.model) &&
    typeof key.dimensions === "number" &&
    Number.isInteger(key.dimensions) &&
    key.dimensions >= 1 &&
    key.dimensions <= MAX_EMBEDDING_DIMENSIONS
  )
}

/** Returns the key when it is safe to interpolate into SQL; throws `EmbeddingError("config")` otherwise. */
export function assertValidEmbeddingKey(key: EmbeddingKey): EmbeddingKey {
  if (!isValidEmbeddingKey(key)) {
    throw new EmbeddingError("Invalid embedding model or dimensions", "config", false)
  }

  return key
}

/** `"<model>:<dims>"` → key, or null when malformed or invalid. */
export function parseEmbeddingKey(value: string | null | undefined): EmbeddingKey | null {
  const match = /^(.+):(\d+)$/.exec(value?.trim() ?? "")

  if (!match) return null
  const key = { model: match[1], dimensions: Number(match[2]) }

  return isValidEmbeddingKey(key) ? key : null
}

function intFrom(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value)

  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback
}

function providerMode(value: string | undefined): EmbeddingProviderMode {
  const mode = value?.trim().toLowerCase()

  return mode === "gemini" || mode === "hash" || mode === "none" ? mode : "auto"
}

export function getEmbeddingConfig(env: Env = process.env): EmbeddingConfig {
  const price = Number(env.MEETSUM_EMBEDDING_PRICE_PER_MTOK)

  return {
    provider: providerMode(env.MEETSUM_EMBEDDING_PROVIDER),
    model: env.MEETSUM_EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL,
    // Out-of-range values are kept so the key fails validation loudly
    // instead of silently falling back to another key.
    dimensions:
      env.MEETSUM_EMBEDDING_DIMENSIONS?.trim() ? Number(env.MEETSUM_EMBEDDING_DIMENSIONS) : DEFAULT_EMBEDDING_DIMENSIONS,
    batchSize: intFrom(env.MEETSUM_EMBEDDING_BATCH_SIZE, 100, 1, 250),
    concurrency: intFrom(env.MEETSUM_EMBEDDING_CONCURRENCY, 2, 1, 16),
    maxRetries: intFrom(env.MEETSUM_EMBEDDING_MAX_RETRIES, 5, 0, 10),
    timeoutMs: intFrom(env.MEETSUM_EMBEDDING_TIMEOUT_MS, 30_000, 1_000, 600_000),
    pricePerMTok: Number.isFinite(price) && price >= 0 ? price : 0.15,
  }
}

export type QueryEmbeddingConfig = {
  /** Overall budget of one query embedding (all attempts), ms. */
  timeoutMs: number
  /** Retries within that budget (0 or 1; never the ingest policy). */
  maxRetries: number
  /** After a failure, skip query embeddings for this key for this long, ms. */
  cooldownMs: number
}

/**
 * Query-time embedding budget (search, palette, Ask retrieval): a 429 or an
 * outage must degrade to lexical quickly instead of riding the ingest retry
 * policy for minutes.
 */
export function getQueryEmbeddingConfig(env: Env = process.env): QueryEmbeddingConfig {
  return {
    timeoutMs: intFrom(env.MEETSUM_QUERY_EMBEDDING_TIMEOUT_MS, 2_500, 50, 30_000),
    maxRetries: intFrom(env.MEETSUM_QUERY_EMBEDDING_MAX_RETRIES, 0, 0, 1),
    cooldownMs: intFrom(env.MEETSUM_QUERY_EMBEDDING_COOLDOWN_MS, 45_000, 0, 600_000),
  }
}
