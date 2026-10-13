import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  embedQuery,
  queryEmbeddingProviderConfig,
  resetEmbeddingQueryCacheForTesting,
  setEmbeddingProviderForTesting,
  type EmbeddingProvider,
} from "@/lib/ai/embeddings"
import { getEmbeddingConfig, getQueryEmbeddingConfig } from "@/lib/ai/embeddings/config"
import { createGeminiEmbeddingProvider, type GeminiEmbedClient } from "@/lib/ai/embeddings/gemini"

/**
 * Query-time embedding has its own budget (M6 review): a Gemini 429 with a
 * long Retry-After, an outage or a client disconnect must never hang a
 * search, a palette keystroke or Ask retrieval. Failures open a per-key
 * circuit so the following requests skip the vector leg for a cooldown.
 */

const base = { task: "RETRIEVAL_QUERY" as const, workspaceId: "ws_1", principalKey: "user_a" }

/** A Gemini provider with the INGEST retry policy (5 retries, 30 s per attempt). */
function ingestPolicyGemini(embedContent: GeminiEmbedClient["models"]["embedContent"]): EmbeddingProvider {
  const config = { ...getEmbeddingConfig({}), dimensions: 2, maxRetries: 5, timeoutMs: 30_000 }

  return createGeminiEmbeddingProvider(config, { client: () => ({ models: { embedContent } }) })
}

function rateLimited(): Error {
  return Object.assign(new Error("Resource exhausted"), { status: 429, headers: { "retry-after": "60" } })
}

beforeEach(() => {
  vi.stubEnv("MEETSUM_QUERY_EMBEDDING_TIMEOUT_MS", "150")
  vi.stubEnv("MEETSUM_QUERY_EMBEDDING_COOLDOWN_MS", "45000")
  resetEmbeddingQueryCacheForTesting()
})

afterEach(() => {
  setEmbeddingProviderForTesting(undefined)
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe("query embedding config", () => {
  it("defaults to a 2.5 s budget, at most one retry and a 45 s cooldown", () => {
    expect(getQueryEmbeddingConfig({})).toEqual({ timeoutMs: 2_500, maxRetries: 0, cooldownMs: 45_000 })
    expect(
      getQueryEmbeddingConfig({
        MEETSUM_QUERY_EMBEDDING_TIMEOUT_MS: "4000",
        MEETSUM_QUERY_EMBEDDING_MAX_RETRIES: "1",
        MEETSUM_QUERY_EMBEDDING_COOLDOWN_MS: "10000",
      })
    ).toEqual({ timeoutMs: 4_000, maxRetries: 1, cooldownMs: 10_000 })
    // Never the ingest policy: more than one retry is clamped back to the default.
    expect(getQueryEmbeddingConfig({ MEETSUM_QUERY_EMBEDDING_MAX_RETRIES: "5" }).maxRetries).toBe(0)
  })

  it("builds the query provider with the query budget, not the ingest retries", () => {
    const config = queryEmbeddingProviderConfig({ MEETSUM_EMBEDDING_MAX_RETRIES: "5", MEETSUM_EMBEDDING_TIMEOUT_MS: "30000" })

    expect(config.maxRetries).toBe(0)
    expect(config.timeoutMs).toBe(2_500)
  })
})

describe("embedQuery budget", () => {
  it("returns null within the budget on a 429 with a long Retry-After", async () => {
    const embedContent = vi.fn(async () => {
      throw rateLimited()
    })

    setEmbeddingProviderForTesting(ingestPolicyGemini(embedContent))
    vi.stubEnv("MEETSUM_QUERY_EMBEDDING_TIMEOUT_MS", "150")

    const started = Date.now()
    const vector = await embedQuery("תקציב", base)

    expect(vector).toBeNull()
    expect(Date.now() - started).toBeLessThan(1_500)
  })

  it("returns null within the budget when the provider hangs and ignores the signal", async () => {
    setEmbeddingProviderForTesting({
      id: "gemini",
      key: { model: "gemini-embedding-001", dimensions: 2 },
      isConfigured: () => true,
      embed: () => new Promise(() => {}),
    })

    const started = Date.now()

    expect(await embedQuery("תקציב", base)).toBeNull()
    expect(Date.now() - started).toBeLessThan(1_500)
  })

  it("cancels on the caller's abort signal and does not open the circuit", async () => {
    vi.stubEnv("MEETSUM_QUERY_EMBEDDING_TIMEOUT_MS", "10000")
    const seen: AbortSignal[] = []
    const embed = vi.fn(
      (_inputs: unknown, opts: { signal?: AbortSignal }) =>
        new Promise<never>(() => {
          if (opts.signal) seen.push(opts.signal)
        })
    )

    setEmbeddingProviderForTesting({
      id: "gemini",
      key: { model: "gemini-embedding-001", dimensions: 2 },
      isConfigured: () => true,
      embed: embed as unknown as EmbeddingProvider["embed"],
    })

    const controller = new AbortController()
    const started = Date.now()
    const pending = embedQuery("תקציב", { ...base, signal: controller.signal })

    setTimeout(() => controller.abort(), 20)

    expect(await pending).toBeNull()
    expect(Date.now() - started).toBeLessThan(1_500)
    expect(seen[0]?.aborted).toBe(true)

    // A disconnect is not a provider failure: the next query still calls it.
    const ok = vi.fn(async () => ({
      vectors: [[1, 0]],
      key: { model: "gemini-embedding-001", dimensions: 2 },
      usage: { inputTokens: 1, estimated: true },
      costUsd: 0,
      latencyMs: 0,
      attempts: 1,
    }))

    setEmbeddingProviderForTesting({
      id: "gemini",
      key: { model: "gemini-embedding-001", dimensions: 2 },
      isConfigured: () => true,
      embed: ok,
    })
    expect(await embedQuery("אחר", base)).toEqual([1, 0])
  })

  it("returns null at once for an already-aborted signal without calling the provider", async () => {
    const embed = vi.fn()

    setEmbeddingProviderForTesting({
      id: "gemini",
      key: { model: "gemini-embedding-001", dimensions: 2 },
      isConfigured: () => true,
      embed,
    })

    expect(await embedQuery("תקציב", { ...base, signal: AbortSignal.abort() })).toBeNull()
    expect(embed).not.toHaveBeenCalled()
  })
})

describe("embedQuery circuit breaker", () => {
  it("skips the provider for the cooldown after a failure, then tries again", async () => {
    const embed = vi.fn(async () => {
      throw rateLimited()
    })
    const provider: EmbeddingProvider = {
      id: "gemini",
      key: { model: "gemini-embedding-001", dimensions: 2 },
      isConfigured: () => true,
      embed: embed as unknown as EmbeddingProvider["embed"],
    }

    setEmbeddingProviderForTesting(provider)
    vi.useFakeTimers({ now: new Date("2026-10-13T10:00:00Z"), toFake: ["Date"] })

    expect(await embedQuery("תקציב", base)).toBeNull()
    expect(embed).toHaveBeenCalledTimes(1)

    // Other principals and queries share the key's circuit.
    expect(await embedQuery("משהו אחר", { ...base, principalKey: "user_b" })).toBeNull()
    vi.setSystemTime(new Date("2026-10-13T10:00:44Z"))
    expect(await embedQuery("עוד", base)).toBeNull()
    expect(embed).toHaveBeenCalledTimes(1)

    vi.setSystemTime(new Date("2026-10-13T10:00:46Z"))
    embed.mockResolvedValueOnce({
      vectors: [[0, 1]],
      key: provider.key,
      usage: { inputTokens: 1, estimated: true },
      costUsd: 0,
      latencyMs: 0,
      attempts: 1,
    } as never)
    expect(await embedQuery("עוד", base)).toEqual([0, 1])
    expect(embed).toHaveBeenCalledTimes(2)
  })

  it("keeps serving cached vectors while the circuit is open", async () => {
    let fail = false
    const embed = vi.fn(async () => {
      if (fail) throw rateLimited()

      return {
        vectors: [[1, 0]],
        key: { model: "gemini-embedding-001", dimensions: 2 },
        usage: { inputTokens: 1, estimated: true },
        costUsd: 0,
        latencyMs: 0,
        attempts: 1,
      }
    })

    setEmbeddingProviderForTesting({
      id: "gemini",
      key: { model: "gemini-embedding-001", dimensions: 2 },
      isConfigured: () => true,
      embed: embed as unknown as EmbeddingProvider["embed"],
    })

    expect(await embedQuery("תקציב", base)).toEqual([1, 0])
    fail = true
    expect(await embedQuery("חדש", base)).toBeNull()
    expect(await embedQuery("תקציב", base)).toEqual([1, 0])
    expect(embed).toHaveBeenCalledTimes(2)
  })
})
