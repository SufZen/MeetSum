import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import {
  generateStructured,
  getLlmStatus,
  LlmChainError,
  LlmError,
  setLlmProvidersForTesting,
  type LlmProvider,
} from "@/lib/ai/llm"
import { resolveRoutes } from "@/lib/ai/llm/router"

const both = { isConfigured: () => true }
const geminiOnly = { isConfigured: (provider: string) => provider === "gemini" }
const anthropicOnly = { isConfigured: (provider: string) => provider === "anthropic" }

function fakeProvider(
  id: "anthropic" | "gemini",
  behavior: (model: string) => unknown,
  configured = true
): LlmProvider & { generate: ReturnType<typeof vi.fn> } {
  return {
    id,
    isConfigured: () => configured,
    generate: vi.fn(async (_req: unknown, model: string) => {
      const value = behavior(model)

      if (value instanceof Error) throw value
      return {
        value,
        provider: id,
        model,
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.001,
        latencyMs: 3,
      }
    }),
  } as LlmProvider & { generate: ReturnType<typeof vi.fn> }
}

const request = (overrides: Record<string, unknown> = {}) => ({
  task: "summary" as const,
  ctx: { workspaceId: "ws_1", promptVersion: "m5.1" },
  language: "he",
  instructions: "x",
  schema: { name: "s", zod: z.object({ ok: z.boolean() }) },
  preference: "auto" as const,
  ...overrides,
})

afterEach(() => {
  setLlmProvidersForTesting(undefined)
})

describe("LLM routing table", () => {
  it("auto routes every task to Gemini first, Claude as fallback", () => {
    expect(resolveRoutes("summary", { ...both, env: {} })).toEqual([
      { provider: "gemini", model: "gemini-3.8-flash" },
      { provider: "anthropic", model: "claude-sonnet-5-5" },
    ])
    expect(resolveRoutes("title_tags_type", { ...both, env: {} })).toEqual([
      { provider: "gemini", model: "gemini-3.5-flash-lite" },
      { provider: "anthropic", model: "claude-haiku-5-5" },
    ])
    expect(resolveRoutes("sentiment", { ...both, env: {} })[0].model).toBe("gemini-3.5-flash-lite")
    expect(resolveRoutes("prep_brief", { ...both, env: {} })[0].provider).toBe("gemini")
  })

  it("works with only Gemini configured", () => {
    expect(resolveRoutes("summary", { ...geminiOnly, env: {} })).toEqual([
      { provider: "gemini", model: "gemini-3.8-flash" },
    ])
    expect(resolveRoutes("judge", { ...geminiOnly, env: {} })).toEqual([])
  })

  it("puts Claude first for the anthropic preference and uses Opus for the judge", () => {
    expect(resolveRoutes("summary", { ...both, preference: "anthropic", env: {} })[0]).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5-5",
    })
    expect(resolveRoutes("summary", { ...anthropicOnly, preference: "gemini", env: {} })).toEqual([
      { provider: "anthropic", model: "claude-sonnet-5-5" },
    ])
    expect(resolveRoutes("judge", { ...both, env: {} })).toEqual([
      { provider: "anthropic", model: "claude-opus-5-5" },
    ])
  })

  it("reads model names from env", () => {
    const env = { GOOGLE_GEMINI_SUMMARY_MODEL: "gemini-9", GOOGLE_GEMINI_FAST_MODEL: "gemini-9-lite" }

    expect(resolveRoutes("summary", { ...geminiOnly, env })[0].model).toBe("gemini-9")
    expect(resolveRoutes("extraction", { ...geminiOnly, env })[0].model).toBe("gemini-9-lite")
  })

  it("honors MEETSUM_LLM_ROUTES and a forced provider/model", () => {
    const env = { MEETSUM_LLM_ROUTES: JSON.stringify({ summary: ["anthropic:claude-x", "gemini:gemini-y"] }) }

    expect(resolveRoutes("summary", { ...both, env })).toEqual([
      { provider: "anthropic", model: "claude-x" },
      { provider: "gemini", model: "gemini-y" },
    ])
    expect(resolveRoutes("summary", { ...both, env: {}, provider: "anthropic" })).toEqual([
      { provider: "anthropic", model: "claude-sonnet-5-5" },
    ])
    expect(resolveRoutes("summary", { ...both, env: {}, model: "gemini-pro-x" })).toEqual([
      { provider: "gemini", model: "gemini-pro-x" },
    ])
    expect(resolveRoutes("summary", { ...geminiOnly, env: {}, provider: "anthropic" })).toEqual([])
  })
})

describe("generateStructured fallback chain", () => {
  it("returns the primary result without fallback", async () => {
    const gemini = fakeProvider("gemini", () => ({ ok: true }))
    const anthropic = fakeProvider("anthropic", () => ({ ok: true }))

    setLlmProvidersForTesting({ gemini, anthropic })
    const result = await generateStructured(request())

    expect(result).toMatchObject({ provider: "gemini", fallbackUsed: false })
    expect(anthropic.generate).not.toHaveBeenCalled()
  })

  it("moves to the next provider on a refusal and records both attempts", async () => {
    const anthropic = fakeProvider("anthropic", () => new LlmError("no", "refusal", "anthropic", false))
    const gemini = fakeProvider("gemini", () => ({ ok: true }))

    setLlmProvidersForTesting({ gemini, anthropic })
    const result = await generateStructured(request({ task: "title_tags_type", preference: "anthropic" }))

    expect(anthropic.generate.mock.calls[0][1]).toBe("claude-haiku-5-5")
    expect(result.provider).toBe("gemini")
    expect(result.fallbackUsed).toBe(true)
    expect(result.attempts.map((attempt) => [attempt.provider, attempt.ok, attempt.kind])).toEqual([
      ["anthropic", false, "refusal"],
      ["gemini", true, undefined],
    ])
  })

  it("throws a chain error with every attempt when all routes fail", async () => {
    setLlmProvidersForTesting({
      gemini: fakeProvider("gemini", () => new LlmError("503", "server", "gemini", true)),
      anthropic: fakeProvider("anthropic", () => new LlmError("429", "rate_limit", "anthropic", true)),
    })

    const error = await generateStructured(request()).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(LlmChainError)
    expect((error as LlmChainError).attempts).toHaveLength(2)
    expect((error as LlmChainError).kind).toBe("rate_limit")
  })

  it("skips unconfigured providers (Gemini only)", async () => {
    const anthropic = fakeProvider("anthropic", () => ({ ok: true }), false)
    const gemini = fakeProvider("gemini", () => new LlmError("bad", "server", "gemini", true))

    setLlmProvidersForTesting({ gemini, anthropic })

    await expect(generateStructured(request())).rejects.toBeInstanceOf(LlmChainError)
    expect(anthropic.generate).not.toHaveBeenCalled()
  })

  it("reports status without network", () => {
    setLlmProvidersForTesting({
      gemini: fakeProvider("gemini", () => ({ ok: true })),
      anthropic: fakeProvider("anthropic", () => ({ ok: true }), false),
    })

    const status = getLlmStatus({ env: {} })

    expect(status.providers).toEqual([
      { id: "gemini", configured: true },
      { id: "anthropic", configured: false },
      { id: "heuristic", configured: true },
    ])
    expect(status.routes.summary).toEqual([{ provider: "gemini", model: "gemini-3.8-flash" }])
    expect(status.heuristicOnly).toBe(false)
  })

  it("warns when GEMINI_TIER=free and when nothing is configured", () => {
    expect(getLlmStatus({ env: { GOOGLE_GEMINI_API_KEY: "k", GEMINI_TIER: "free" } }).warnings).toEqual([
      expect.stringContaining("may be used by Google"),
    ])
    expect(getLlmStatus({ env: { GOOGLE_GEMINI_API_KEY: "k" } }).warnings).toEqual([])

    const none = getLlmStatus({ env: {} })

    expect(none.heuristicOnly).toBe(true)
    expect(none.warnings?.[0]).toContain("heuristic fallback")
  })
})
