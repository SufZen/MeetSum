/**
 * Deterministic test embedder (docs/parity/m6.md, A4):
 * `MEETSUM_EMBEDDING_PROVIDER=hash`, key `hash-test:256`. Token-hash bag of
 * words: FNV-1a over the folded tokens (weight 1) and their prefix/stem
 * variants (weight 0.5) into signed buckets, L2-normalized. No network.
 *
 * Never available in production (`isConfigured` is false when
 * `NODE_ENV=production`). Used by the eval `pglite` engine and the e2e.
 */
import { l2Normalize } from "@/lib/ai/embeddings/gemini"
import type { EmbeddingBatchResult, EmbeddingProvider } from "@/lib/ai/embeddings/types"
import { estimateTokens } from "@/lib/intelligence/transcript-format"
import { normalizeForIndex } from "@/lib/search/hebrew-normalize"
import type { EmbeddingKey } from "@/lib/search/types"

type Env = Record<string, string | undefined>

export const HASH_EMBEDDING_KEY: EmbeddingKey = { model: "hash-test", dimensions: 256 }

const VARIANT_WEIGHT = 0.5

export function fnv1a(text: string): number {
  let hash = 0x811c9dc5

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }

  return hash >>> 0
}

export function hashEmbed(text: string, dimensions = HASH_EMBEDDING_KEY.dimensions): number[] {
  const vector = new Array<number>(dimensions).fill(0)
  const { norm, stems } = normalizeForIndex(text)
  const add = (token: string, weight: number) => {
    const hash = fnv1a(token)
    const sign = (hash >>> 31) & 1 ? -1 : 1

    vector[hash % dimensions] += sign * weight
  }

  for (const token of norm.split(" ").filter(Boolean)) add(token, 1)
  for (const token of stems.split(" ").filter(Boolean)) add(token, VARIANT_WEIGHT)

  // An empty text still gets a unit vector (cosine distance stays defined).
  if (vector.every((value) => value === 0)) vector[0] = 1

  return l2Normalize(vector)
}

export function isHashEmbeddingAllowed(env: Env = process.env): boolean {
  return env.NODE_ENV !== "production"
}

export function createHashEmbeddingProvider(key: EmbeddingKey = HASH_EMBEDDING_KEY): EmbeddingProvider {
  return {
    id: "hash",
    key,
    isConfigured: (env?: Env) => isHashEmbeddingAllowed(env ?? process.env),
    async embed(inputs, opts): Promise<EmbeddingBatchResult> {
      const startedAt = Date.now()

      if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("aborted")

      return {
        vectors: inputs.map((input) => hashEmbed(input.text, key.dimensions)),
        key,
        usage: { inputTokens: inputs.reduce((sum, input) => sum + estimateTokens(input.text), 0), estimated: true },
        costUsd: 0,
        latencyMs: Date.now() - startedAt,
        attempts: inputs.length ? 1 : 0,
      }
    },
  }
}
