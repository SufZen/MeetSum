import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

const generateStructured = vi.hoisted(() => vi.fn())

vi.mock("@/lib/ai/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/llm")>()

  return { ...actual, generateStructured }
})

import { judgeInstructions, runJudge } from "@/lib/ai/llm-eval/judge"
import {
  parseLlmEvalArgs,
  runLlmEvaluation,
  toCandidateRecording,
  type CandidateRunner,
  type JudgeRunner,
} from "@/lib/ai/llm-eval/run"
import type { EvalMeetingFixture } from "@/lib/ai/llm-eval/types"

const fixedDeps = {
  now: () => new Date("2026-10-13T00:00:00.000Z"),
  gitSha: () => "abc",
}

let tempDir: string | undefined

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
  tempDir = undefined
  generateStructured.mockReset()
})

describe("parseLlmEvalArgs", () => {
  it("defaults to replaying the committed recordings", () => {
    expect(parseLlmEvalArgs([], {})).toMatchObject({
      mode: "replay",
      replayDir: "tests/fixtures/llm-eval/recorded",
      batch: false,
      manifest: ".secrets/llm-eval/manifest.json",
    })
    expect(parseLlmEvalArgs(["--live", "--batch", "--record", "out"], {})).toMatchObject({
      mode: "live",
      batch: true,
      recordDir: "out",
    })
    expect(() => parseLlmEvalArgs(["--batch"], {})).toThrow("--live")
    expect(() => parseLlmEvalArgs(["--nope"], {})).toThrow("Unknown flag")
    expect(() => parseLlmEvalArgs(["--baseline", "openai:x"], {})).toThrow()
  })
})

describe("replay", () => {
  it("runs with an empty environment, without the network, deterministically", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const first = await runLlmEvaluation(parseLlmEvalArgs([], {}), { ...fixedDeps, env: {} })
    const second = await runLlmEvaluation(parseLlmEvalArgs([], {}), { ...fixedDeps, env: {} })

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(generateStructured).not.toHaveBeenCalled()
    expect(second).toEqual(first)
    expect(first.synthetic).toBe(true)
    expect(first.meetings).toHaveLength(6)
    expect(first.baseline).toBe("gemini:gemini-3.5-flash-lite")
    expect(first.candidates).toEqual(["gemini:gemini-3.8-flash", "gemini:gemini-3.5-flash-lite"])
    expect(first.fixtureSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(first.decisions[0].outcome).toBe("insufficient_data")
    fetchSpy.mockRestore()
  })

  it("filters to one meeting", async () => {
    const report = await runLlmEvaluation(parseLlmEvalArgs(["--meeting", "he-board-update"], {}), {
      ...fixedDeps,
      env: {},
    })

    expect(report.meetings.map((meeting) => meeting.id)).toEqual(["he-board-update"])
  })
})

describe("live mode with injected runners", () => {
  const runCandidate: CandidateRunner = async ({ candidate, meeting }) => ({
    meetingId: meeting.id,
    decisions: meeting.reference.decisions,
    actionItems: candidate.includes("lite") ? meeting.reference.actionItems.slice(1) : meeting.reference.actionItems,
    citations: [meeting.segments[0].id],
    chapterCount: 2,
    languageCheck: "passed",
    latencyMs: 100,
    usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
  })
  const runJudgeStub: JudgeRunner = async ({ meeting, a, b }) => ({
    meetingId: meeting.id,
    a: a.spec,
    b: b.spec,
    verdicts: {
      faithfulness: { winner: a.spec.includes("lite") ? "B" : "A", rationale: "r" },
      coverage: { winner: "tie", rationale: "r" },
      hebrew_fluency: { winner: a.spec.includes("lite") ? "B" : "A", rationale: "r" },
      action_item_recall: { winner: "A", rationale: "r" },
    },
  })

  it("judges each challenger/baseline pair in both orders, records and replays", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "llm-eval-"))
    const judge = vi.fn(runJudgeStub)
    const env = {
      MEETSUM_LLM_PRICES_JSON: JSON.stringify({
        "gemini-3.8-flash": { input: 0.5, output: 3 },
        "gemini-3.5-flash-lite": { input: 0.1, output: 0.4 },
      }),
    }
    const live = await runLlmEvaluation(
      parseLlmEvalArgs(["--live", "--record", tempDir, "--manifest", path.join(tempDir, "none.json")], {}),
      { ...fixedDeps, env, runCandidate, runJudge: judge }
    )

    expect(judge).toHaveBeenCalledTimes(12)
    expect(live.synthetic).toBe(false)
    expect(live.candidates).toEqual(["gemini:gemini-3.8-flash", "gemini:gemini-3.5-flash-lite"])
    expect(live.comparisons[0].criteria.faithfulness).toMatchObject({ wins: 6, ties: 0, losses: 0 })
    // action_item_recall: "A" in both orders → inconsistent → tie
    expect(live.comparisons[0].criteria.action_item_recall).toMatchObject({ wins: 0, ties: 6 })
    expect(live.decisions[0].outcome).toBe("keep_baseline") // cost ratio > 3×
    expect(live.perCandidate[0].costPerMeetingUsd).toBeCloseTo(0.0008)

    const replayed = await runLlmEvaluation(parseLlmEvalArgs(["--replay", tempDir], {}), { ...fixedDeps, env })

    expect(replayed.synthetic).toBe(false)
    expect(replayed.comparisons).toEqual(live.comparisons)
    expect(replayed.perCandidate).toEqual(live.perCandidate)
  })

  it("adds Claude candidates only when ANTHROPIC_API_KEY is set", async () => {
    const seen = new Set<string>()
    const recordCandidate: CandidateRunner = async (input) => {
      seen.add(input.candidate)
      return runCandidate(input)
    }

    await runLlmEvaluation(parseLlmEvalArgs(["--live", "--meeting", "he-board-update"], {}), {
      ...fixedDeps,
      env: {},
      runCandidate: recordCandidate,
      runJudge: runJudgeStub,
    })
    expect([...seen]).toEqual(["gemini:gemini-3.8-flash", "gemini:gemini-3.5-flash-lite"])

    seen.clear()
    const report = await runLlmEvaluation(parseLlmEvalArgs(["--live", "--meeting", "he-board-update"], {}), {
      ...fixedDeps,
      env: { ANTHROPIC_API_KEY: "test" },
      runCandidate: recordCandidate,
      runJudge: runJudgeStub,
    })

    expect([...seen]).toContain("anthropic:claude-sonnet-5-5")
    expect(report.judges).toEqual(["anthropic:claude-opus-5-5"])
  })

  it("records candidate failures as errors instead of aborting", async () => {
    const report = await runLlmEvaluation(parseLlmEvalArgs(["--live", "--meeting", "he-board-update"], {}), {
      ...fixedDeps,
      env: {},
      runCandidate: async () => {
        throw new Error("no key")
      },
      runJudge: runJudgeStub,
    })

    expect(report.perCandidate.map((row) => row.errors)).toEqual([1, 1])
    expect(report.decisions[0].outcome).toBe("insufficient_data")
  })
})

describe("runJudge", () => {
  const meeting: EvalMeetingFixture = {
    id: "m",
    _synthetic: true,
    title: "t",
    language: "he",
    startedAt: "2026-10-01T00:00:00.000Z",
    segments: [{ id: "s1", speaker: "דנה", startMs: 0, endMs: 1000, text: "שלום" }],
    reference: { actionItems: [], decisions: [], keyTopics: [] },
  }
  const output = toCandidateRecording(meeting, { overview: "x", decisions: ["d"], actionItems: [{ title: "t", owner: "o", dueDate: "2026-10-02T00:00:00Z", sourceSegmentId: "s1" }] }, 5)

  it("sends the transcript as shared context and forces the judge model", async () => {
    generateStructured.mockResolvedValue({
      value: {
        faithfulness: { winner: "A", rationale: "One. Two. Three." },
        coverage: { winner: "tie", rationale: "x" },
        hebrew_fluency: { winner: "B", rationale: "x" },
        action_item_recall: { winner: "A", rationale: "x" },
      },
    })

    const record = await runJudge({ judge: "anthropic:claude-opus-5-5", meeting, a: { spec: "gemini:a", output }, b: { spec: "gemini:b", output }, batch: true })
    const request = generateStructured.mock.calls[0][0]

    expect(request).toMatchObject({ task: "judge", provider: "anthropic", model: "claude-opus-5-5", batch: true, effort: "high" })
    expect(request.sharedContext).toContain("[s1 00:00 דנה] שלום")
    expect(record.verdicts.faithfulness).toEqual({ winner: "A", rationale: "One. Two." })
    expect(output).toMatchObject({ citations: ["s1"], actionItems: [{ title: "t", owner: "o", dueOn: "2026-10-02" }] })
    expect(judgeInstructions(output, output)).toContain("<summary_a>")
  })
})
