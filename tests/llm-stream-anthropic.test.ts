import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Streaming chat, Claude route (docs/parity/m6.md, C1 tests): Claude first
 * with preference `anthropic`, cache flags only on system/history blocks,
 * cache-read usage, refusal handling and Gemini fallback before a delta.
 */

vi.mock("@/lib/settings/app-settings", () => ({
  getAppSettings: async () => ({ llmProviderPreference: "auto" }),
}))

const { setChatStreamersForTesting, streamText } = await import("@/lib/ai/llm/stream")
const { createGeminiStreamer } = await import("@/lib/ai/llm/gemini-stream")
const { buildAnthropicStreamParams, createAnthropicStreamer } = await import("@/lib/ai/llm/anthropic-stream")
type LlmStreamEvent = import("@/lib/ai/llm/types").LlmStreamEvent
type LlmStreamRequest = import("@/lib/ai/llm/types").LlmStreamRequest

function request(overrides: Partial<LlmStreamRequest> = {}): LlmStreamRequest {
  return {
    task: "chat",
    ctx: { workspaceId: "ws_1", promptVersion: "m6.ask.1" },
    language: "en",
    system: [{ text: "shared prefix", cache: true }, { text: "ask instructions" }],
    messages: [
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "earlier answer [s1]", cache: true },
      { role: "user", content: "<question>this request</question>" },
    ],
    ...overrides,
  }
}

async function* items(list: unknown[]) {
  for (const item of list) yield item
}

function claudeClient(events: unknown[], final: unknown) {
  return { messages: { stream: vi.fn(() => Object.assign(items(events), { finalMessage: async () => final })) } }
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

beforeEach(() => {
  delete process.env.MEETSUM_LLM_REPLAY_DIR
  delete process.env.MEETSUM_STORAGE
})

afterEach(() => {
  setChatStreamersForTesting(undefined)
})

describe("Claude chat streaming", () => {
  it("puts cache_control only on flagged system blocks and history messages", () => {
    const params = buildAnthropicStreamParams(request(), "claude-sonnet-5-5", {})

    expect(params.system[0]).toMatchObject({ text: "shared prefix", cache_control: { type: "ephemeral", ttl: "5m" } })
    expect(params.system[1]).not.toHaveProperty("cache_control")
    expect(params.messages[1].content[0]).toHaveProperty("cache_control")
    expect(params.messages[2].content[0]).not.toHaveProperty("cache_control")
    expect(params.messages[0].content[0]).not.toHaveProperty("cache_control")
    expect(params).not.toHaveProperty("tools")
  })

  it("streams Claude first with preference anthropic and reports cache-read tokens", async () => {
    const claude = claudeClient(
      [
        { type: "message_start" },
        { type: "content_block_delta", delta: { type: "text_delta", text: "Approved " } },
        { type: "content_block_delta", delta: { type: "text_delta", text: "[s1]." } },
      ],
      {
        model: "claude-sonnet-5-5",
        stop_reason: "end_turn",
        usage: { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 0 },
      }
    )
    const gemini = { models: { generateContentStream: vi.fn() } }

    setChatStreamersForTesting({
      anthropic: createAnthropicStreamer({ client: claude }),
      gemini: createGeminiStreamer({ client: gemini }),
    })

    const { events, error } = await collect(streamText(request({ preference: "anthropic" })))
    const done = events.at(-1) as Extract<LlmStreamEvent, { type: "done" }>

    expect(error).toBeUndefined()
    expect(events[0]).toEqual({ type: "start", provider: "anthropic", model: "claude-sonnet-5-5" })
    expect(done.text).toBe("Approved [s1].")
    expect(done.usage.cacheReadTokens).toBe(9_000)
    expect(done.costUsd).toBeGreaterThan(0)
    expect(gemini.models.generateContentStream).not.toHaveBeenCalled()
  })

  it("falls back to Gemini when Claude refuses before any delta", async () => {
    const claude = claudeClient([], { stop_reason: "refusal", usage: {} })
    const gemini = {
      models: {
        generateContentStream: vi.fn(async () =>
          items([{ text: "From Gemini [s1].", usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }])
        ),
      },
    }

    setChatStreamersForTesting({
      anthropic: createAnthropicStreamer({ client: claude }),
      gemini: createGeminiStreamer({ client: gemini }),
    })

    const { events } = await collect(streamText(request({ preference: "anthropic" })))

    expect(events.map((event) => event.type)).toEqual(["start", "fallback", "start", "delta", "done"])
    expect(events[1]).toEqual({ type: "fallback", from: "anthropic", to: "gemini", reason: "refusal" })
  })

  it("passes the abort signal to the SDK", async () => {
    const claude = claudeClient([], { stop_reason: "end_turn", usage: {} })
    const controller = new AbortController()

    setChatStreamersForTesting({
      anthropic: createAnthropicStreamer({ client: claude }),
      gemini: createGeminiStreamer({ client: { models: { generateContentStream: vi.fn() } } }),
    })
    await collect(streamText(request({ preference: "anthropic", signal: controller.signal })))

    expect(claude.messages.stream.mock.calls[0]).toEqual([expect.anything(), { signal: controller.signal }])
  })
})
