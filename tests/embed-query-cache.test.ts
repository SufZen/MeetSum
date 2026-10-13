import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  embedDocuments,
  embeddingQueryCacheKey,
  embedQuery,
  setEmbeddingProviderForTesting,
  type EmbeddingProvider,
} from "@/lib/ai/embeddings"

function countingProvider(): EmbeddingProvider & { embed: ReturnType<typeof vi.fn> } {
  let counter = 0

  return {
    id: "hash",
    key: { model: "hash-test", dimensions: 2 },
    isConfigured: () => true,
    embed: vi.fn(async (inputs: { text: string }[]) => ({
      vectors: inputs.map(() => [(counter += 1), 0]),
      key: { model: "hash-test", dimensions: 2 },
      usage: { inputTokens: 1, estimated: true },
      costUsd: 0,
      latencyMs: 0,
      attempts: 1,
    })),
  }
}

const base = { task: "RETRIEVAL_QUERY" as const, workspaceId: "ws_1" }

let provider: ReturnType<typeof countingProvider>

beforeEach(() => {
  provider = countingProvider()
  setEmbeddingProviderForTesting(provider)
})

afterEach(() => setEmbeddingProviderForTesting(undefined))

describe("embedQuery cache", () => {
  it("keys the cache by workspace, principal, model key, task and folded text", () => {
    expect(
      embeddingQueryCacheKey({
        workspaceId: "ws_1",
        principalKey: "user_a",
        key: { model: "gemini-embedding-001", dimensions: 1536 },
        task: "RETRIEVAL_QUERY",
        folded: "תקציב",
      })
    ).toBe("ws_1|user_a|gemini-embedding-001:1536|RETRIEVAL_QUERY|תקציב")
  })

  it("reuses a vector for the same principal and folded query", async () => {
    const first = await embedQuery("תַּקְצִיב", { ...base, principalKey: "user_a" })
    const second = await embedQuery("  תקציב ", { ...base, principalKey: "user_a" })

    expect(first).toEqual(second)
    expect(provider.embed).toHaveBeenCalledTimes(1)
  })

  it("never serves user A's cached vector to user B, another workspace or another task", async () => {
    const a = await embedQuery("תקציב", { ...base, principalKey: "user_a" })
    const b = await embedQuery("תקציב", { ...base, principalKey: "user_b" })
    const otherWorkspace = await embedQuery("תקציב", { ...base, workspaceId: "ws_2", principalKey: "user_a" })
    const otherTask = await embedQuery("תקציב", { ...base, task: "QUESTION_ANSWERING", principalKey: "user_a" })

    expect(provider.embed).toHaveBeenCalledTimes(4)
    expect(new Set([a, b, otherWorkspace, otherTask].map((vector) => vector?.[0])).size).toBe(4)
  })

  it("returns null without a provider, for empty text, and on any error", async () => {
    expect(await embedQuery("   ", { ...base, principalKey: "user_a" })).toBeNull()

    provider.embed.mockRejectedValueOnce(new Error("boom"))
    expect(await embedQuery("שגיאה", { ...base, principalKey: "user_a" })).toBeNull()

    setEmbeddingProviderForTesting(null)
    expect(await embedQuery("תקציב", { ...base, principalKey: "user_a" })).toBeNull()
    await expect(embedDocuments([{ text: "x" }], { workspaceId: "ws_1" })).rejects.toMatchObject({ kind: "config" })
  })
})
