import { describe, expect, it, vi } from "vitest"

import { runPipelineCandidate } from "@/lib/ai/llm-eval/run"
import type { EvalMeetingFixture } from "@/lib/ai/llm-eval/types"
import type { IntelligencePipelineResult } from "@/lib/intelligence/pipeline"

const meeting: EvalMeetingFixture = {
  id: "eval_1",
  _synthetic: true,
  title: "סטטוס",
  language: "he",
  startedAt: "2026-10-01T10:00:00.000Z",
  segments: [{ id: "s1", speaker: "דנה", startMs: 0, endMs: 4000, text: "נשלח את ה-PR מחר" }],
  reference: { actionItems: [], decisions: [], keyTopics: [] },
}

function result(provider: string, fallbackUsed = false): IntelligencePipelineResult {
  return {
    intelligence: {
      overview: "סיכום",
      decisions: ["משיקים"],
      actionItems: [{ title: "לשלוח PR", owner: "דנה", status: "open", sourceSegmentId: "s1" }],
      generation: { provider, languageCheck: "passed", costUsd: 0.01 },
    },
    run: {
      provider,
      model: provider === "heuristic" ? "heuristic-v1" : "gemini-3.8-flash",
      fallbackUsed,
      costUsd: 0.01,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      aiRunIds: [],
      templateKey: "general",
      language: "he",
      languageCheck: "passed",
      promptVersion: "x",
    },
  } as unknown as IntelligencePipelineResult
}

describe("LLM eval live runner", () => {
  it("calls runIntelligencePipeline with the forced {provider, model} and unwraps the result", async () => {
    const runIntelligencePipeline = vi.fn().mockResolvedValue(result("gemini"))
    const recording = await runPipelineCandidate(
      { runIntelligencePipeline },
      { provider: "gemini", model: "gemini-3.8-flash" },
      meeting
    )

    expect(runIntelligencePipeline).toHaveBeenCalledWith(
      expect.objectContaining({ id: "eval_1", transcript: meeting.segments }),
      expect.objectContaining({ provider: "gemini", model: "gemini-3.8-flash", settings: expect.any(Object) })
    )
    expect(recording).toMatchObject({
      meetingId: "eval_1",
      overview: "סיכום",
      decisions: ["משיקים"],
      actionItems: [{ title: "לשלוח PR", owner: "דנה" }],
      citations: ["s1"],
      languageCheck: "passed",
      costUsd: 0.01,
    })
  })

  it("rejects heuristic fallbacks and answers from another provider", async () => {
    await expect(
      runPipelineCandidate(
        { runIntelligencePipeline: vi.fn().mockResolvedValue(result("heuristic", true)) },
        { provider: "gemini", model: "gemini-3.8-flash" },
        meeting
      )
    ).rejects.toThrow(/did not answer/)
    await expect(
      runPipelineCandidate(
        { runIntelligencePipeline: vi.fn().mockResolvedValue(result("gemini")) },
        { provider: "anthropic", model: "claude-sonnet-5-5" },
        meeting
      )
    ).rejects.toThrow(/did not answer/)
  })
})
