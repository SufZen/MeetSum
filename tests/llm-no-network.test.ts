import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { generateStructured, getLlmStatus, LlmError, setLlmProvidersForTesting } from "@/lib/ai/llm"
import { runIntelligencePipeline } from "@/lib/intelligence/pipeline"
import type { MeetingRecord } from "@/lib/meetings/repository"

const KEYS = [
  "ANTHROPIC_API_KEY",
  "GOOGLE_GEMINI_API_KEY",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "MEETSUM_STORAGE",
]

const saved: Record<string, string | undefined> = {}
let fetchSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  for (const key of KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  setLlmProvidersForTesting(undefined)
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("network access in a unit test")
  })
})

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  fetchSpy.mockRestore()
})

describe("LLM layer without keys", () => {
  it("fails fast with LlmError(config) and no network", async () => {
    const error = await generateStructured({
      task: "summary",
      ctx: { workspaceId: "ws_1", promptVersion: "m5.1" },
      language: "he",
      instructions: "x",
      schema: { name: "s", zod: z.object({ ok: z.boolean() }) },
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).kind).toBe("config")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("reports heuristic-only status", () => {
    expect(getLlmStatus().heuristicOnly).toBe(true)
  })

  it("the pipeline falls back to the heuristic V2 summary", async () => {
    const meeting: MeetingRecord = {
      id: "m1",
      title: "Weekly",
      source: "upload",
      language: "he",
      status: "summarizing",
      retention: "audio",
      startedAt: "2026-10-15T07:00:00.000Z",
      participants: [],
      workspaceId: "ws_1",
      transcript: [
        { id: "seg1", speaker: "דנה", startMs: 0, endMs: 4_000, text: "צריך לשלוח את ההצעה ללקוח עד יום ראשון" },
        { id: "seg2", speaker: "יואב", startMs: 5_000, endMs: 8_000, text: "יש בעיה עם ה-API של Supabase" },
      ],
    }

    const { intelligence, run } = await runIntelligencePipeline(meeting)

    expect(run).toMatchObject({ provider: "heuristic", fallbackUsed: true })
    expect(intelligence.version).toBe(2)
    expect(intelligence.generation).toMatchObject({ provider: "heuristic", fallbackUsed: true })
    expect(intelligence.chapters).toBeUndefined()
    expect(intelligence.items?.find((item) => item.kind === "risk")?.refs).toEqual([
      { segmentId: "seg2", startMs: 5_000 },
    ])
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
