import { afterEach, describe, expect, it, vi } from "vitest"

import { getEmbeddingProvider } from "@/lib/ai/embeddings"
import { createHashEmbeddingProvider, hashEmbed, HASH_EMBEDDING_KEY } from "@/lib/ai/embeddings/hash"

const cosine = (a: number[], b: number[]) => a.reduce((sum, value, index) => sum + value * b[index], 0)

afterEach(() => vi.unstubAllEnvs())

describe("hash embedder", () => {
  it("is deterministic, normalized and keyed hash-test:256", async () => {
    const provider = createHashEmbeddingProvider()
    const first = await provider.embed([{ text: "דיברנו על התקציב" }], { task: "RETRIEVAL_DOCUMENT" })
    const second = await provider.embed([{ text: "דיברנו על התקציב" }], { task: "RETRIEVAL_QUERY" })

    expect(first.key).toEqual(HASH_EMBEDDING_KEY)
    expect(first.key).toEqual({ model: "hash-test", dimensions: 256 })
    expect(first.vectors[0]).toHaveLength(256)
    expect(first.vectors).toEqual(second.vectors)
    expect(cosine(first.vectors[0], first.vectors[0])).toBeCloseTo(1, 10)
    expect(first.costUsd).toBe(0)
  })

  it("places prefixed forms near their stem and unrelated text far away", () => {
    const query = hashEmbed("תקציב")

    expect(cosine(query, hashEmbed("והתקציב"))).toBeGreaterThan(cosine(query, hashEmbed("גיוס עובדים")))
    expect(hashEmbed("")).toHaveLength(256)
    expect(cosine(hashEmbed(""), hashEmbed(""))).toBeCloseTo(1, 10)
  })

  it("is disabled in production", () => {
    const provider = createHashEmbeddingProvider()

    expect(provider.isConfigured({ NODE_ENV: "development" })).toBe(true)
    expect(provider.isConfigured({ NODE_ENV: "production" })).toBe(false)
    expect(getEmbeddingProvider({ MEETSUM_EMBEDDING_PROVIDER: "hash", NODE_ENV: "test" })?.id).toBe("hash")
    expect(getEmbeddingProvider({ MEETSUM_EMBEDDING_PROVIDER: "hash", NODE_ENV: "production" })).toBeNull()
    // auto never selects the test embedder.
    expect(getEmbeddingProvider({ NODE_ENV: "test" })).toBeNull()
  })
})
