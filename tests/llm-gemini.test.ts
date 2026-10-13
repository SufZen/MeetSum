import { beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

const genai = vi.hoisted(() => ({ generateContent: vi.fn(), constructed: [] as unknown[] }))

vi.mock("@google/genai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@google/genai")>()

  class FakeGoogleGenAI {
    models = { generateContent: genai.generateContent }

    constructor(options: unknown) {
      genai.constructed.push(options)
    }
  }

  return { ...actual, GoogleGenAI: FakeGoogleGenAI }
})

const { ApiError } = await import("@google/genai")
const { createGeminiProvider, mapGeminiError } = await import("@/lib/ai/llm/gemini")

const schema = z.object({ title: z.string(), tags: z.array(z.string()) })

function request(overrides: Record<string, unknown> = {}) {
  return {
    task: "summary" as const,
    ctx: { workspaceId: "ws_1", promptVersion: "m5.1" },
    language: "he",
    sharedContext: "[s1 00:00 דנה] שלום",
    instructions: "סכם",
    schema: { name: "t", zod: schema },
    ...overrides,
  }
}

function response(text: string, overrides: Record<string, unknown> = {}) {
  return {
    text,
    candidates: [{ finishReason: "STOP" }],
    usageMetadata: {
      promptTokenCount: 10_000,
      candidatesTokenCount: 1_000,
      cachedContentTokenCount: 4_000,
      thoughtsTokenCount: 200,
    },
    ...overrides,
  }
}

const env = { GOOGLE_GEMINI_API_KEY: "test-key" }

beforeEach(() => {
  genai.generateContent.mockReset()
  genai.constructed.length = 0
})

describe("Gemini provider", () => {
  it("sends JSON mode with responseJsonSchema and the shared system instruction", async () => {
    genai.generateContent.mockResolvedValue(response(JSON.stringify({ title: "x", tags: [] })))
    const provider = createGeminiProvider({ env })

    await provider.generate(request(), "gemini-3.8-flash")

    const params = genai.generateContent.mock.calls[0][0]
    expect(params.model).toBe("gemini-3.8-flash")
    expect(params.config.responseMimeType).toBe("application/json")
    expect(params.config.responseJsonSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["title", "tags"],
    })
    expect(params.config.systemInstruction).toContain("<transcript>")
    expect(params.contents[0].parts[0].text).toBe("סכם")
  })

  it("keeps the system instruction identical across tasks", async () => {
    genai.generateContent.mockResolvedValue(response(JSON.stringify({ title: "x", tags: [] })))
    const provider = createGeminiProvider({ env })

    await provider.generate(request({ task: "title_tags_type", instructions: "A" }), "gemini-3.5-flash-lite")
    await provider.generate(request({ task: "sentiment", instructions: "B" }), "gemini-3.5-flash-lite")

    const [first, second] = genai.generateContent.mock.calls.map(([params]) => params)
    expect(first.config.systemInstruction).toBe(second.config.systemInstruction)
  })

  it("maps usageMetadata (cached tokens split out, thoughts billed as output) and prices it", async () => {
    genai.generateContent.mockResolvedValue(response(JSON.stringify({ title: "x", tags: [] })))
    const provider = createGeminiProvider({ env })

    const result = await provider.generate(request(), "gemini-3.8-flash")

    expect(result.usage).toEqual({
      inputTokens: 6_000,
      outputTokens: 1_200,
      cacheReadTokens: 4_000,
      cacheWriteTokens: 0,
    })
    // (6000 + 4000) * 0.75 + 1200 * 3.75 = 12000 per MTok
    expect(result.costUsd).toBeCloseTo(0.012, 8)
    expect(result.provider).toBe("gemini")
  })

  it("repairs invalid output once, then fails with invalid_output", async () => {
    genai.generateContent
      .mockResolvedValueOnce(response("{\"title\": 1}"))
      .mockResolvedValueOnce(response(JSON.stringify({ title: "ok", tags: ["a"] })))
    const provider = createGeminiProvider({ env })

    await expect(provider.generate(request(), "gemini-3.8-flash")).resolves.toMatchObject({
      value: { title: "ok", tags: ["a"] },
    })

    genai.generateContent.mockReset().mockResolvedValue(response("```json\n{}\n```"))
    await expect(provider.generate(request(), "gemini-3.8-flash")).rejects.toMatchObject({
      kind: "invalid_output",
    })
  })

  it("treats a blocked prompt as a refusal", async () => {
    genai.generateContent.mockResolvedValue(
      response("", { promptFeedback: { blockReason: "SAFETY" }, candidates: [] })
    )
    const provider = createGeminiProvider({ env })

    await expect(provider.generate(request(), "gemini-3.8-flash")).rejects.toMatchObject({
      kind: "refusal",
    })
  })

  it("maps API errors by status", () => {
    expect(mapGeminiError(new ApiError({ message: "no", status: 403 })).kind).toBe("auth")
    expect(mapGeminiError(new ApiError({ message: "slow", status: 429 })).kind).toBe("rate_limit")
    expect(mapGeminiError(new ApiError({ message: "down", status: 503 })).kind).toBe("server")
    expect(mapGeminiError(new ApiError({ message: "bad", status: 400 })).kind).toBe("bad_request")
    expect(mapGeminiError(new Error("request timed out")).kind).toBe("timeout")
  })

  it("is not configured without a key and never builds a client", async () => {
    const provider = createGeminiProvider({ env: {} })

    expect(provider.isConfigured({})).toBe(false)
    await expect(provider.generate(request(), "gemini-3.8-flash")).rejects.toMatchObject({
      kind: "config",
    })
    expect(genai.constructed).toHaveLength(0)
  })
})
