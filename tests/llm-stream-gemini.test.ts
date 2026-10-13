import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Streaming chat, Gemini default route (docs/parity/m6.md, C1 tests): the
 * default route, request shape, usage -> cost, the `ai_runs` row, fallback
 * before the first delta, error after a delta, abort, and no prompt text in
 * `ai_runs.error`.
 */

const db = vi.hoisted(() => ({ queries: [] as Array<{ text: string; values: unknown[] }> }))

vi.mock("@/lib/db/client", () => ({
  getDatabasePool: () => ({
    query: async (text: string, values: unknown[] = []) => {
      db.queries.push({ text, values })
      return { rows: [] }
    },
  }),
}))
vi.mock("@/lib/settings/app-settings", () => ({
  getAppSettings: async () => ({ llmProviderPreference: "auto" }),
}))

const { setChatStreamersForTesting, streamText } = await import("@/lib/ai/llm/stream")
const { buildGeminiStreamParams, createGeminiStreamer } = await import("@/lib/ai/llm/gemini-stream")
const { createAnthropicStreamer } = await import("@/lib/ai/llm/anthropic-stream")
const { LlmError } = await import("@/lib/ai/llm/types")
type LlmStreamEvent = import("@/lib/ai/llm/types").LlmStreamEvent
type LlmStreamRequest = import("@/lib/ai/llm/types").LlmStreamRequest

const SECRET = "סוד מהתמלול 12345"

function request(overrides: Partial<LlmStreamRequest> = {}): LlmStreamRequest {
  return {
    task: "chat",
    ctx: { workspaceId: "ws_1", meetingId: "m1", promptVersion: "m6.ask.1" },
    language: "he",
    system: [{ text: `<transcript>${SECRET}</transcript>`, cache: true }, { text: "הוראות" }],
    messages: [{ role: "user", content: "<question>מה הוחלט?</question>" }],
    maxOutputTokens: 500,
    ...overrides,
  }
}

async function* chunks(items: unknown[], failAfter?: Error) {
  for (const item of items) yield item
  if (failAfter) throw failAfter
}

function geminiClient(impl: (params: unknown) => Promise<AsyncIterable<unknown>>) {
  return { models: { generateContentStream: vi.fn(impl) } }
}

function anthropicClient(events: unknown[], final: unknown) {
  return {
    messages: {
      stream: vi.fn(() => Object.assign(chunks(events), { finalMessage: async () => final })),
    },
  }
}

async function collect(stream: AsyncIterable<LlmStreamEvent>) {
  const events: LlmStreamEvent[] = []
  let error: unknown

  try {
    for await (const event of stream) events.push(event)
  } catch (caught) {
    error = caught
  }
  return { events, error }
}

const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ["MEETSUM_STORAGE", "MEETSUM_LLM_REPLAY_DIR", "MEETSUM_LLM_ROUTES", "MEETSUM_LLM_PROVIDER_DEFAULT"]) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  process.env.MEETSUM_STORAGE = "postgres"
  db.queries = []
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  setChatStreamersForTesting(undefined)
})

const usageChunk = {
  text: "",
  candidates: [{ finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 10_000, candidatesTokenCount: 300, cachedContentTokenCount: 8_000 },
}

describe("Gemini chat streaming", () => {
  it("routes to gemini-3.8-flash by default and maps usage to cost and an ai_runs row", async () => {
    const client = geminiClient(async () => chunks([{ text: "התקציב " }, { text: "אושר [s1]." }, usageChunk]))

    setChatStreamersForTesting({
      gemini: createGeminiStreamer({ client }),
      anthropic: createAnthropicStreamer({ client: anthropicClient([], {}) }),
    })

    const { events, error } = await collect(streamText(request()))

    expect(error).toBeUndefined()
    expect(events[0]).toEqual({ type: "start", provider: "gemini", model: "gemini-3.8-flash" })
    expect(events.filter((event) => event.type === "delta").map((event) => (event as { text: string }).text)).toEqual([
      "התקציב ",
      "אושר [s1].",
    ])

    const done = events.at(-1) as Extract<LlmStreamEvent, { type: "done" }>

    expect(done.type).toBe("done")
    expect(done.text).toBe("התקציב אושר [s1].")
    expect(done.usage).toEqual({ inputTokens: 2_000, outputTokens: 300, cacheReadTokens: 8_000, cacheWriteTokens: 0 })
    expect(done.costUsd).toBeGreaterThan(0)
    expect(done.aiRunId).toMatch(/^airun_/)

    const insert = db.queries.find((query) => query.text.includes("insert into ai_runs"))!

    expect(insert.values[3]).toBe("llm.chat")
    expect(insert.values[4]).toBe("completed")
    expect(insert.values[6]).toBe("gemini-3.8-flash")
    expect(insert.values[17]).toBe(8_000) // cache_read_tokens
    expect(insert.values[19]).toBe("m6.ask.1")
    expect(JSON.parse(insert.values[5] as string)).toMatchObject({ languageCheck: "passed", stream: true })
  })

  it("sends the system blocks as systemInstruction and maps assistant turns to model", () => {
    const params = buildGeminiStreamParams(
      request({
        messages: [
          { role: "user", content: "q1" },
          { role: "assistant", content: "a1" },
          { role: "user", content: "q2" },
        ],
      }),
      "gemini-3.8-flash"
    )

    expect(params.config.systemInstruction).toBe(`<transcript>${SECRET}</transcript>\n\nהוראות`)
    expect(params.contents.map((content) => content.role)).toEqual(["user", "model", "user"])
    expect(params.config.maxOutputTokens).toBe(500)
    expect(params).not.toHaveProperty("tools")
    expect(params.config).not.toHaveProperty("tools")
  })

  it("falls back to Claude before the first delta and records the failed attempt without prompt text", async () => {
    const failing = geminiClient(async () => {
      throw Object.assign(new Error(`429 quota exceeded for prompt ${SECRET}`), { status: 429 })
    })
    const claude = anthropicClient(
      [{ type: "content_block_delta", delta: { type: "text_delta", text: "תשובה [s1]." } }],
      { model: "claude-sonnet-5-5", stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 10 } }
    )

    setChatStreamersForTesting({
      gemini: createGeminiStreamer({ client: failing }),
      anthropic: createAnthropicStreamer({ client: claude }),
    })

    const { events, error } = await collect(streamText(request()))

    expect(error).toBeUndefined()
    expect(events.map((event) => event.type)).toEqual(["start", "fallback", "start", "delta", "done"])
    expect(events[1]).toEqual({ type: "fallback", from: "gemini", to: "anthropic", reason: "rate_limit" })

    const failed = db.queries.find((query) => query.values[4] === "failed")!

    expect(failed.values[10]).toBe("rate_limit error from gemini")
    expect(JSON.stringify(db.queries)).not.toContain(SECRET)
  })

  it("does not fall back after the first delta: the stream throws", async () => {
    const client = geminiClient(async () =>
      chunks([{ text: "התחלה" }], Object.assign(new Error(`500 ${SECRET}`), { status: 500 }))
    )
    const claude = anthropicClient([], {})

    setChatStreamersForTesting({
      gemini: createGeminiStreamer({ client }),
      anthropic: createAnthropicStreamer({ client: claude }),
    })

    const { events, error } = await collect(streamText(request()))

    expect(events.map((event) => event.type)).toEqual(["start", "delta"])
    expect(error).toBeInstanceOf(LlmError)
    expect((error as InstanceType<typeof LlmError>).kind).toBe("server")
    expect(claude.messages.stream).not.toHaveBeenCalled()
    expect(JSON.stringify(db.queries)).not.toContain(SECRET)
  })

  it("treats a blocked response as a refusal and falls back", async () => {
    const blocked = geminiClient(async () => chunks([{ promptFeedback: { blockReason: "SAFETY" } }]))
    const claude = anthropicClient(
      [{ type: "content_block_delta", delta: { type: "text_delta", text: "ok [s1]" } }],
      { stop_reason: "end_turn", usage: {} }
    )

    setChatStreamersForTesting({
      gemini: createGeminiStreamer({ client: blocked }),
      anthropic: createAnthropicStreamer({ client: claude }),
    })

    const { events } = await collect(streamText(request()))

    expect(events[1]).toMatchObject({ type: "fallback", reason: "refusal" })
  })

  it("passes the abort signal and stops without falling back when aborted", async () => {
    const controller = new AbortController()
    const client = geminiClient(async (params) => {
      expect((params as { config: { abortSignal?: AbortSignal } }).config.abortSignal).toBe(controller.signal)
      return (async function* () {
        yield { text: "חלק" }
        controller.abort()
        yield { text: " נוסף" }
      })()
    })
    const claude = anthropicClient([], {})

    setChatStreamersForTesting({
      gemini: createGeminiStreamer({ client }),
      anthropic: createAnthropicStreamer({ client: claude }),
    })

    const { events, error } = await collect(streamText(request({ signal: controller.signal })))

    expect(events.filter((event) => event.type === "delta")).toHaveLength(1)
    expect(error).toBeInstanceOf(LlmError)
    expect(claude.messages.stream).not.toHaveBeenCalled()
    expect(db.queries.find((query) => query.values[4] === "failed")?.values[10]).toBe("aborted")
  })

  it("records an aborted ai_runs attempt when the consumer stops reading (iterator.return)", async () => {
    let upstreamClosed = false
    const client = geminiClient(async () =>
      (async function* () {
        try {
          yield { text: "חלק" }
          yield { text: " נוסף" }
          yield usageChunk
        } finally {
          upstreamClosed = true
        }
      })()
    )

    setChatStreamersForTesting({
      gemini: createGeminiStreamer({ client }),
      anthropic: createAnthropicStreamer({ client: anthropicClient([], {}) }),
    })

    const stream = streamText(request())

    for (;;) {
      const next = await stream.next()

      if (next.done || next.value.type === "delta") break
    }
    await stream.return(undefined)

    const failed = db.queries.find((query) => query.text.includes("insert into ai_runs") && query.values[4] === "failed")

    expect(upstreamClosed).toBe(true)
    expect(failed?.values[10]).toBe("aborted")
    expect(JSON.stringify(db.queries)).not.toContain(SECRET)
  })

  it("fails fast with LlmError(config) when no provider is configured", async () => {
    setChatStreamersForTesting({
      gemini: { id: "gemini", isConfigured: () => false, stream: () => chunks([]) as never },
      anthropic: { id: "anthropic", isConfigured: () => false, stream: () => chunks([]) as never },
    })

    const { events, error } = await collect(streamText(request()))

    expect(events).toEqual([])
    expect((error as InstanceType<typeof LlmError>).kind).toBe("config")
  })
})
