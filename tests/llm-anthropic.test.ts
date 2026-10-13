import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

const sdk = vi.hoisted(() => ({
  constructorArgs: [] as unknown[],
  create: vi.fn(),
  betaCreate: vi.fn(),
  stream: vi.fn(),
  betaStream: vi.fn(),
}))

vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>()

  class FakeAnthropic {
    messages = {
      create: sdk.create,
      stream: (...args: unknown[]) => ({ finalMessage: () => sdk.stream(...args) }),
    }
    beta = {
      messages: {
        create: sdk.betaCreate,
        stream: (...args: unknown[]) => ({ finalMessage: () => sdk.betaStream(...args) }),
      },
    }

    constructor(options: unknown) {
      sdk.constructorArgs.push(options)
    }
  }

  return { ...actual, default: FakeAnthropic }
})

const { AuthenticationError, RateLimitError, InternalServerError, BadRequestError, APIConnectionTimeoutError } =
  await import("@anthropic-ai/sdk")
const { createAnthropicProvider, mapAnthropicError, SERVER_FALLBACK_BETA } = await import(
  "@/lib/ai/llm/anthropic"
)
const { LlmError } = await import("@/lib/ai/llm/types")

const schema = z.object({ title: z.string(), note: z.string().optional() })

function request(overrides: Record<string, unknown> = {}) {
  return {
    task: "summary" as const,
    ctx: { workspaceId: "ws_1", meetingId: "m1", promptVersion: "m5.1" },
    language: "he",
    sharedContext: "[s1 00:00 דנה] שלום",
    instructions: "החזר כותרת",
    schema: { name: "t", zod: schema },
    ...overrides,
  }
}

function message(text: string, overrides: Record<string, unknown> = {}) {
  return {
    model: "claude-sonnet-5-5",
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 900,
    },
    ...overrides,
  }
}

const env = { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_SERVER_FALLBACK: "true" }

beforeEach(() => {
  sdk.constructorArgs.length = 0
  for (const fn of [sdk.create, sdk.betaCreate, sdk.stream, sdk.betaStream]) fn.mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("Anthropic provider", () => {
  it("builds the client from env with retries and timeout", async () => {
    sdk.create.mockResolvedValue(message(JSON.stringify({ title: "x" }), { model: "claude-haiku-5-5" }))
    const provider = createAnthropicProvider({
      env: { ...env, ANTHROPIC_MAX_RETRIES: "5", ANTHROPIC_TIMEOUT_MS: "1234" },
    })

    await provider.generate(request({ task: "title_tags_type" }), "claude-haiku-5-5")

    expect(sdk.constructorArgs[0]).toEqual({ apiKey: "test-key", maxRetries: 5, timeout: 1234 })
  })

  it("puts the transcript in the cache_control system block and instructions in the user turn", async () => {
    sdk.create.mockResolvedValue(message(JSON.stringify({ title: "x" }), { model: "claude-haiku-5-5" }))
    const provider = createAnthropicProvider({ env })

    await provider.generate(request({ task: "title_tags_type" }), "claude-haiku-5-5")

    const params = sdk.create.mock.calls[0][0]
    expect(params.system).toHaveLength(1)
    expect(params.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "5m" })
    expect(params.system[0].text).toContain("<transcript>\n[s1 00:00 דנה] שלום\n</transcript>")
    expect(params.messages).toEqual([{ role: "user", content: "החזר כותרת" }])
  })

  it("passes the abort signal and per-request maxRetries for interactive requests", async () => {
    sdk.create.mockResolvedValue(message(JSON.stringify({ title: "x" }), { model: "claude-haiku-5-5" }))
    const provider = createAnthropicProvider({ env })
    const signal = AbortSignal.timeout(60_000)

    await provider.generate(request({ task: "title_tags_type", signal, maxRetries: 1 }), "claude-haiku-5-5")

    expect(sdk.create.mock.calls[0][1]).toEqual({ signal, maxRetries: 1 })
  })

  it("keeps the cached prefix byte-identical across tasks", async () => {
    sdk.create.mockImplementation(async () =>
      message(JSON.stringify({ title: "x" }), { model: "claude-haiku-5-5" })
    )
    const provider = createAnthropicProvider({ env })

    await provider.generate(request({ task: "title_tags_type", instructions: "A" }), "claude-haiku-5-5")
    await provider.generate(request({ task: "sentiment", instructions: "B" }), "claude-haiku-5-5")

    const [first, second] = sdk.create.mock.calls.map(([params]) => params)
    expect(first.system).toEqual(second.system)
    expect(first.messages).not.toEqual(second.messages)
  })

  it("uses output_config.format with no tool_choice, prefill or thinking", async () => {
    sdk.create.mockResolvedValue(message(JSON.stringify({ title: "x" }), { model: "claude-haiku-5-5" }))
    const provider = createAnthropicProvider({ env })

    await provider.generate(request({ task: "title_tags_type" }), "claude-haiku-5-5")

    const params = sdk.create.mock.calls[0][0]
    expect(params.output_config.format.type).toBe("json_schema")
    expect(params.output_config.format.schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["title", "note"],
    })
    expect(params.output_config.effort).toBe("low")
    expect(params).not.toHaveProperty("tool_choice")
    expect(params).not.toHaveProperty("thinking")
    expect(params.messages.every((entry: { role: string }) => entry.role === "user")).toBe(true)
  })

  it("sends the server-side fallback beta only for sonnet/opus non-batch calls", async () => {
    sdk.betaCreate.mockResolvedValue(message(JSON.stringify({ title: "x" })))
    sdk.create.mockResolvedValue(message(JSON.stringify({ title: "x" })))
    const provider = createAnthropicProvider({ env })

    await provider.generate(request(), "claude-sonnet-5-5")
    expect(sdk.betaCreate).toHaveBeenCalledTimes(1)
    expect(sdk.betaCreate.mock.calls[0][0]).toMatchObject({
      betas: [SERVER_FALLBACK_BETA],
      fallbacks: "default",
    })
    expect(sdk.betaCreate.mock.calls[0][0].output_config.effort).toBe("medium")

    await provider.generate(request({ batch: true }), "claude-opus-5-5")
    await provider.generate(request({ task: "title_tags_type" }), "claude-haiku-5-5")
    expect(sdk.betaCreate).toHaveBeenCalledTimes(1)
    expect(sdk.create).toHaveBeenCalledTimes(2)
    for (const [params] of sdk.create.mock.calls) {
      expect(params).not.toHaveProperty("betas")
      expect(params).not.toHaveProperty("fallbacks")
    }
  })

  it("streams when maxOutputTokens is above 16000", async () => {
    sdk.betaStream.mockResolvedValue(message(JSON.stringify({ title: "x" })))
    const provider = createAnthropicProvider({ env })

    await provider.generate(request({ maxOutputTokens: 20_000 }), "claude-sonnet-5-5")

    expect(sdk.betaStream).toHaveBeenCalledTimes(1)
    expect(sdk.betaCreate).not.toHaveBeenCalled()
  })

  it("maps a refusal stop_reason to a non-retryable refusal error", async () => {
    sdk.betaCreate.mockResolvedValue(message("", { stop_reason: "refusal", content: [] }))
    const provider = createAnthropicProvider({ env })

    await expect(provider.generate(request(), "claude-sonnet-5-5")).rejects.toMatchObject({
      kind: "refusal",
      retryable: false,
    })
  })

  it("returns usage with cache tokens and a cost", async () => {
    sdk.betaCreate.mockResolvedValue(
      message(JSON.stringify({ title: "x", note: null }), {
        usage: {
          input_tokens: 1_000,
          output_tokens: 500,
          cache_read_input_tokens: 10_000,
          cache_creation_input_tokens: 0,
        },
      })
    )
    const provider = createAnthropicProvider({ env })

    const result = await provider.generate(request(), "claude-sonnet-5-5")

    expect(result.value).toEqual({ title: "x" })
    expect(result.usage).toEqual({
      inputTokens: 1_000,
      outputTokens: 500,
      cacheReadTokens: 10_000,
      cacheWriteTokens: 0,
    })
    // 1000*2 + 500*10 + 10000*0.2 = 9000 per MTok
    expect(result.costUsd).toBeCloseTo(0.009, 8)
  })

  it("repairs once on invalid output, then fails with invalid_output", async () => {
    sdk.betaCreate
      .mockResolvedValueOnce(message("not json"))
      .mockResolvedValueOnce(message(JSON.stringify({ title: "fixed" })))
    const provider = createAnthropicProvider({ env })

    const repaired = await provider.generate(request(), "claude-sonnet-5-5")

    expect(repaired.value.title).toBe("fixed")
    expect(sdk.betaCreate.mock.calls[1][0].messages[0].content).toContain(
      "did not match the required JSON schema"
    )

    sdk.betaCreate.mockReset().mockResolvedValue(message(JSON.stringify({ wrong: 1 })))
    await expect(provider.generate(request(), "claude-sonnet-5-5")).rejects.toMatchObject({
      kind: "invalid_output",
    })
    expect(sdk.betaCreate).toHaveBeenCalledTimes(2)
  })

  it("feeds validate() errors into the repair retry", async () => {
    sdk.betaCreate
      .mockResolvedValueOnce(message(JSON.stringify({ title: "" })))
      .mockResolvedValueOnce(message(JSON.stringify({ title: "ok" })))
    const provider = createAnthropicProvider({ env })

    const result = await provider.generate(
      request({ validate: (value: { title: string }) => (value.title ? [] : ["title: empty"]) }),
      "claude-sonnet-5-5"
    )

    expect(result.value.title).toBe("ok")
    expect(sdk.betaCreate.mock.calls[1][0].messages[0].content).toContain("title: empty")
  })

  it("maps typed SDK errors", () => {
    const headers = new Headers()

    expect(mapAnthropicError(new AuthenticationError(401, {}, "bad key", headers)).kind).toBe("auth")
    expect(mapAnthropicError(new RateLimitError(429, {}, "slow down", headers))).toMatchObject({
      kind: "rate_limit",
      retryable: true,
    })
    expect(mapAnthropicError(new InternalServerError(503, {}, "down", headers)).kind).toBe("server")
    expect(mapAnthropicError(new BadRequestError(400, {}, "bad", headers)).kind).toBe("bad_request")
    expect(mapAnthropicError(new APIConnectionTimeoutError({ message: "t" })).kind).toBe("timeout")
    expect(mapAnthropicError(new Error("boom")).kind).toBe("unknown")
  })

  it("is not configured without a key and fails with config instead of calling out", async () => {
    const provider = createAnthropicProvider({ env: {} })

    expect(provider.isConfigured({})).toBe(false)
    await expect(provider.generate(request(), "claude-sonnet-5-5")).rejects.toBeInstanceOf(LlmError)
    await expect(provider.generate(request(), "claude-sonnet-5-5")).rejects.toMatchObject({
      kind: "config",
    })
    expect(sdk.constructorArgs).toHaveLength(0)
  })
})

describe("Message Batches (eval only)", () => {
  it("creates, polls and maps results by custom_id at batch prices, without the fallback beta", async () => {
    const { runMessageBatch } = await import("@/lib/ai/llm/batch")
    const create = vi.fn().mockResolvedValue({ id: "batch_1" })
    const retrieve = vi
      .fn()
      .mockResolvedValueOnce({ id: "batch_1", processing_status: "in_progress" })
      .mockResolvedValueOnce({ id: "batch_1", processing_status: "ended" })
    const results = vi.fn().mockResolvedValue(
      (async function* () {
        yield {
          custom_id: "a",
          result: {
            type: "succeeded",
            message: {
              model: "claude-opus-5-5",
              stop_reason: "end_turn",
              content: [{ type: "text", text: JSON.stringify({ title: "A" }) }],
              usage: { input_tokens: 1_000_000, output_tokens: 0 },
            },
          },
        }
        yield { custom_id: "b", result: { type: "errored" } }
      })()
    )
    const sleep = vi.fn().mockResolvedValue(undefined)

    const output = await runMessageBatch(
      [
        { customId: "a", req: request({ task: "judge" }), model: "claude-opus-5-5" },
        { customId: "b", req: request({ task: "judge" }), model: "claude-opus-5-5" },
      ],
      { client: { messages: { batches: { create, retrieve, results } } }, sleep }
    )

    const params = create.mock.calls[0][0].requests[0].params

    expect(params).not.toHaveProperty("betas")
    expect(params.output_config.effort).toBe("high")
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(output).toEqual([
      expect.objectContaining({ customId: "a", ok: true, value: { title: "A" }, costUsd: 2 }),
      { customId: "b", ok: false, error: "errored" },
    ])
  })
})
