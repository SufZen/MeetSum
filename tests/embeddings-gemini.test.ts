import { afterEach, describe, expect, it, vi } from "vitest"

const sdk = vi.hoisted(() => ({ embedContent: vi.fn(), constructed: [] as unknown[] }))

vi.mock("@google/genai", () => ({
  GoogleGenAI: vi.fn(function GoogleGenAI(options: unknown) {
    sdk.constructed.push(options)
    return { models: { embedContent: sdk.embedContent } }
  }),
}))

import { getEmbeddingConfig } from "@/lib/ai/embeddings/config"
import { createGeminiEmbeddingProvider, isGeminiEmbeddingConfigured, type GeminiEmbedClient } from "@/lib/ai/embeddings/gemini"
import { getActiveEmbeddingKey, getEmbeddingProvider } from "@/lib/ai/embeddings"

const config = (overrides: Record<string, string> = {}) =>
  getEmbeddingConfig({ MEETSUM_EMBEDDING_DIMENSIONS: "4", ...overrides })

function fakeClient(dimensions = 4, tokenCount?: number) {
  const embedContent = vi.fn(async (params: { contents: string[] }) => ({
    embeddings: params.contents.map((_, index) => ({
      values: Array.from({ length: dimensions }, (__, d) => (d === 0 ? 3 : d === 1 ? 4 : 0) * (index + 1)),
      ...(tokenCount !== undefined ? { statistics: { tokenCount } } : {}),
    })),
  }))
  const client: GeminiEmbedClient = { models: { embedContent } }

  return { client, embedContent }
}

afterEach(() => {
  sdk.embedContent.mockReset()
  sdk.constructed.length = 0
})

describe("Gemini embedding provider", () => {
  it("sends taskType, outputDimensionality and the title, and L2-normalizes", async () => {
    const { client, embedContent } = fakeClient()
    const provider = createGeminiEmbeddingProvider(config(), { client: () => client })
    const result = await provider.embed(
      [
        { text: "התקציב של הרבעון", title: "סקירת תקציב" },
        { text: "Supabase migration", title: "סקירת תקציב" },
      ],
      { task: "RETRIEVAL_DOCUMENT" }
    )

    expect(embedContent).toHaveBeenCalledTimes(1)
    const params = embedContent.mock.calls[0][0] as { model: string; contents: string[]; config: Record<string, unknown> }

    expect(params.model).toBe("gemini-embedding-001")
    expect(params.contents).toEqual(["התקציב של הרבעון", "Supabase migration"])
    expect(params.config).toMatchObject({ taskType: "RETRIEVAL_DOCUMENT", outputDimensionality: 4, title: "סקירת תקציב" })
    expect(params.config.abortSignal).toBeInstanceOf(AbortSignal)
    expect(result.vectors).toEqual([
      [0.6, 0.8, 0, 0],
      [0.6, 0.8, 0, 0],
    ])
    expect(result.key).toEqual({ model: "gemini-embedding-001", dimensions: 4 })
    expect(result.attempts).toBe(1)
  })

  it("omits the title for query tasks", async () => {
    const { client, embedContent } = fakeClient()
    const provider = createGeminiEmbeddingProvider(config(), { client: () => client })

    await provider.embed([{ text: "מה הוחלט על התקציב?", title: "x" }], { task: "RETRIEVAL_QUERY" })

    expect((embedContent.mock.calls[0][0] as unknown as { config: Record<string, unknown> }).config).not.toHaveProperty("title")
  })

  it("batches by MEETSUM_EMBEDDING_BATCH_SIZE and keeps input order", async () => {
    const { client, embedContent } = fakeClient()
    const provider = createGeminiEmbeddingProvider(config({ MEETSUM_EMBEDDING_BATCH_SIZE: "2", MEETSUM_EMBEDDING_CONCURRENCY: "2" }), {
      client: () => client,
    })
    const result = await provider.embed(
      Array.from({ length: 5 }, (_, index) => ({ text: `chunk ${index}` })),
      { task: "RETRIEVAL_DOCUMENT" }
    )

    expect(embedContent.mock.calls.map((call) => (call[0] as { contents: string[] }).contents)).toEqual([
      ["chunk 0", "chunk 1"],
      ["chunk 2", "chunk 3"],
      ["chunk 4"],
    ])
    expect(result.vectors).toHaveLength(5)
    expect(result.attempts).toBe(3)
  })

  it("estimates tokens and cost when the API reports no usage, and uses reported counts otherwise", async () => {
    const estimated = await createGeminiEmbeddingProvider(config(), { client: () => fakeClient().client }).embed(
      [{ text: "abcdef" }],
      { task: "RETRIEVAL_DOCUMENT" }
    )

    expect(estimated.usage).toEqual({ inputTokens: 2, estimated: true })
    expect(estimated.costUsd).toBeCloseTo((2 * 0.15) / 1e6, 12)

    const reported = await createGeminiEmbeddingProvider(config({ MEETSUM_EMBEDDING_PRICE_PER_MTOK: "1" }), {
      client: () => fakeClient(4, 7).client,
    }).embed([{ text: "abcdef" }, { text: "x" }], { task: "RETRIEVAL_DOCUMENT" })

    expect(reported.usage).toEqual({ inputTokens: 14, estimated: false })
    expect(reported.costUsd).toBeCloseTo(14 / 1e6, 12)
  })

  it("rejects vectors with the wrong dimensions", async () => {
    const provider = createGeminiEmbeddingProvider(config(), { client: () => fakeClient(3).client })

    await expect(provider.embed([{ text: "x" }], { task: "RETRIEVAL_DOCUMENT" })).rejects.toMatchObject({
      name: "EmbeddingError",
      kind: "server",
    })
  })

  it("falls back to one request per input when a batch returns the wrong count", async () => {
    const embedContent = vi.fn(async (params: { contents: string[] }) => ({
      embeddings: [{ values: [1, 0, 0, 0] }].slice(0, params.contents.length === 1 ? 1 : 1),
    }))
    const provider = createGeminiEmbeddingProvider(config(), { client: () => ({ models: { embedContent } }) })
    const result = await provider.embed([{ text: "a" }, { text: "b" }], { task: "RETRIEVAL_DOCUMENT" })

    expect(embedContent).toHaveBeenCalledTimes(3)
    expect(result.vectors).toEqual([
      [1, 0, 0, 0],
      [1, 0, 0, 0],
    ])
  })

  it("uses the SDK client from lib/ai/llm/gemini-client by default", async () => {
    vi.stubEnv("GOOGLE_GEMINI_API_KEY", "test-key")
    sdk.embedContent.mockResolvedValue({ embeddings: [{ values: [0, 2, 0, 0] }] })
    const provider = createGeminiEmbeddingProvider(config())
    const result = await provider.embed([{ text: "x" }], { task: "RETRIEVAL_QUERY" })

    expect(sdk.constructed).toHaveLength(1)
    expect(result.vectors[0]).toEqual([0, 1, 0, 0])
    vi.unstubAllEnvs()
  })
})

describe("provider selection", () => {
  it("auto picks Gemini when configured, with the 1536-dimension default key", () => {
    const env = { GOOGLE_GEMINI_API_KEY: "k" }

    expect(getEmbeddingProvider(env)?.id).toBe("gemini")
    expect(getActiveEmbeddingKey(env)).toEqual({ model: "gemini-embedding-001", dimensions: 1536 })
    expect(getEmbeddingProvider({})).toBeNull()
    expect(getEmbeddingProvider({ ...env, MEETSUM_EMBEDDING_PROVIDER: "none" })).toBeNull()
  })

  it("reads Vertex credentials", () => {
    expect(
      isGeminiEmbeddingConfigured({
        GOOGLE_GENAI_USE_VERTEXAI: "true",
        GOOGLE_CLOUD_PROJECT: "p",
        GOOGLE_CLOUD_LOCATION: "l",
        GOOGLE_APPLICATION_CREDENTIALS: "/c.json",
      })
    ).toBe(true)
    expect(isGeminiEmbeddingConfigured({ GOOGLE_GENAI_USE_VERTEXAI: "true", GOOGLE_GEMINI_API_KEY: "k" })).toBe(false)
  })

  it("disables embeddings for an invalid model or dimensions (they become SQL literals)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const env = { GOOGLE_GEMINI_API_KEY: "k" }

    expect(getEmbeddingProvider({ ...env, MEETSUM_EMBEDDING_MODEL: "x'; drop table meetings; --" })).toBeNull()
    expect(getEmbeddingProvider({ ...env, MEETSUM_EMBEDDING_DIMENSIONS: "3072" })).toBeNull()
    expect(getEmbeddingProvider({ ...env, MEETSUM_EMBEDDING_DIMENSIONS: "1.5" })).toBeNull()
    expect(getActiveEmbeddingKey({ ...env, MEETSUM_EMBEDDING_DIMENSIONS: "768" })).toEqual({
      model: "gemini-embedding-001",
      dimensions: 768,
    })
    vi.restoreAllMocks()
  })
})
