import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

const db = vi.hoisted(() => ({ query: vi.fn() }))

vi.mock("@/lib/db/client", () => ({ getDatabasePool: () => ({ query: db.query }) }))

const { generateStructured, LlmError, setLlmProvidersForTesting } = await import("@/lib/ai/llm")
const { createAnthropicProvider } = await import("@/lib/ai/llm/anthropic")
const { insertAiRun } = await import("@/lib/ai/llm/runs")

type Row = unknown[]

function aiRunRows(): Row[] {
  return db.query.mock.calls
    .filter(([sql]) => typeof sql === "string" && sql.includes("insert into ai_runs"))
    .map(([, values]) => values as Row)
}

/** Column order of `insertAiRun`. */
const COL = {
  id: 0,
  meetingId: 1,
  provider: 2,
  task: 3,
  status: 4,
  metadata: 5,
  model: 6,
  error: 10,
  jobId: 11,
  cost: 12,
  workspaceId: 14,
  inputTokens: 15,
  outputTokens: 16,
  cacheRead: 17,
  cacheWrite: 18,
  promptVersion: 19,
  templateKey: 20,
  batch: 21,
}

function claudeMessage(usage: Record<string, number>) {
  return {
    model: "claude-haiku-5-5",
    stop_reason: "end_turn",
    content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
    usage,
  }
}

const request = (overrides: Record<string, unknown> = {}) => ({
  task: "title_tags_type" as const,
  ctx: {
    workspaceId: "ws_1",
    meetingId: "m1",
    jobId: "job_1",
    promptVersion: "m5.1",
    templateKey: "hebrew_business",
  },
  language: "he",
  sharedContext: "[s1 00:00 דנה] שלום",
  instructions: "x",
  schema: { name: "s", zod: z.object({ ok: z.boolean() }) },
  preference: "anthropic" as const,
  ...overrides,
})

beforeEach(() => {
  process.env.MEETSUM_STORAGE = "postgres"
  db.query.mockReset().mockResolvedValue({ rows: [] })
})

afterEach(() => {
  delete process.env.MEETSUM_STORAGE
  setLlmProvidersForTesting(undefined)
})

describe("ai_runs for LLM calls", () => {
  it("writes tokens, cache tokens, cost, prompt version and template key", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        claudeMessage({
          input_tokens: 50,
          output_tokens: 10,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 4_000,
        })
      )
      .mockResolvedValueOnce(
        claudeMessage({
          input_tokens: 60,
          output_tokens: 12,
          cache_read_input_tokens: 4_000,
          cache_creation_input_tokens: 0,
        })
      )
    const anthropic = createAnthropicProvider({
      client: { messages: { create }, beta: { messages: { create } } } as never,
      env: { ANTHROPIC_API_KEY: "k" },
    })

    setLlmProvidersForTesting({ anthropic })
    const first = await generateStructured(request())
    const second = await generateStructured(request({ task: "sentiment", instructions: "y" }))

    const rows = aiRunRows()

    expect(rows).toHaveLength(2)
    expect(rows[0][COL.task]).toBe("llm.title_tags_type")
    expect(rows[0][COL.status]).toBe("completed")
    expect(rows[0][COL.provider]).toBe("anthropic")
    expect(rows[0][COL.model]).toBe("claude-haiku-5-5")
    expect(rows[0][COL.workspaceId]).toBe("ws_1")
    expect(rows[0][COL.meetingId]).toBe("m1")
    expect(rows[0][COL.jobId]).toBe("job_1")
    expect(rows[0].slice(COL.inputTokens, COL.batch + 1)).toEqual([
      50,
      10,
      0,
      4_000,
      "m5.1",
      "hebrew_business",
      false,
    ])
    expect(rows[0][COL.cost]).toBeGreaterThan(0)
    expect(rows[0][COL.id]).toBe(first.aiRunId)
    // The second task on the same meeting reads the cached transcript prefix.
    expect(rows[1][COL.cacheRead]).toBe(4_000)
    expect(rows[1][COL.task]).toBe("llm.sentiment")
    expect(second.usage.cacheReadTokens).toBeGreaterThan(0)
    expect(JSON.parse(rows[1][COL.metadata] as string)).toMatchObject({ fallbackUsed: false })
  })

  it("writes one failed row per failed attempt plus the completed row", async () => {
    const generate = vi.fn()
    const anthropic = {
      id: "anthropic" as const,
      isConfigured: () => true,
      generate: generate.mockRejectedValue(new LlmError("declined", "refusal", "anthropic", false)),
    }
    const gemini = {
      id: "gemini" as const,
      isConfigured: () => true,
      generate: vi.fn().mockResolvedValue({
        value: { ok: true },
        provider: "gemini",
        model: "gemini-3.5-flash-lite",
        usage: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.0001,
        latencyMs: 2,
      }),
    }

    setLlmProvidersForTesting({ anthropic, gemini })
    await generateStructured(request({ runMetadata: { languageCheck: "passed" } }))

    const rows = aiRunRows()

    expect(rows.map((row) => [row[COL.provider], row[COL.status]])).toEqual([
      ["anthropic", "failed"],
      ["gemini", "completed"],
    ])
    expect(rows[0][COL.error]).toBe("declined")
    expect(JSON.parse(rows[1][COL.metadata] as string)).toMatchObject({
      fallbackUsed: true,
      languageCheck: "passed",
    })
  })

  it("records failed attempts when every route fails", async () => {
    setLlmProvidersForTesting({
      anthropic: {
        id: "anthropic",
        isConfigured: () => true,
        generate: vi.fn().mockRejectedValue(new LlmError("down", "server", "anthropic", true)),
      },
      gemini: { id: "gemini", isConfigured: () => false, generate: vi.fn() },
    })

    await expect(generateStructured(request())).rejects.toMatchObject({ kind: "server" })
    expect(aiRunRows().map((row) => row[COL.status])).toEqual(["failed"])
  })

  it("does not write rows when record is false or storage is not postgres", async () => {
    setLlmProvidersForTesting({
      gemini: {
        id: "gemini",
        isConfigured: () => true,
        generate: vi.fn().mockResolvedValue({
          value: { ok: true },
          provider: "gemini",
          model: "gemini-3.8-flash",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          costUsd: null,
          latencyMs: 1,
        }),
      },
      anthropic: { id: "anthropic", isConfigured: () => false, generate: vi.fn() },
    })

    await generateStructured(request({ record: false, preference: "auto" }))
    delete process.env.MEETSUM_STORAGE
    await generateStructured(request({ preference: "auto" }))

    expect(aiRunRows()).toHaveLength(0)
  })

  it("never fails the caller when the insert throws", async () => {
    db.query.mockRejectedValue(new Error("db down"))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    await expect(
      insertAiRun({ task: "x", status: "completed", provider: "gemini", startedAt: Date.now() })
    ).resolves.toMatch(/^airun_/)
    warn.mockRestore()
  })
})
