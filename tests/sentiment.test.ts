import { beforeEach, describe, expect, it, vi } from "vitest"

const generateStructured = vi.hoisted(() => vi.fn())

vi.mock("@/lib/ai/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/llm")>()

  return { ...actual, generateStructured }
})

import {
  aggregateSentiment,
  analyzeSentiment,
  buildSpeakerTurns,
  isSentimentEnabled,
  reaggregateSentiment,
  SENTIMENT_BATCH_SIZE,
  SENTIMENT_TURN_MAX_CHARS,
  type SentimentResponse,
} from "@/lib/analytics/sentiment"
import { LlmError, type LlmStructuredRequest } from "@/lib/ai/llm"
import type { Chapter } from "@/lib/intelligence"
import type { MeetingSpeaker, TranscriptSegment } from "@/lib/meetings/repository"

function segments(count: number): TranscriptSegment[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `s${index}`,
    speaker: index % 2 === 0 ? "Speaker 1" : "Speaker 2",
    speakerId: index % 2 === 0 ? "spk_a" : "spk_b",
    startMs: index * 10_000,
    endMs: index * 10_000 + 9_000,
    text: `תור מספר ${index}`,
  }))
}

const speakers: MeetingSpeaker[] = [
  { id: "spk_a", meetingId: "m1", label: "Speaker 1", displayName: "דנה", mappingStatus: "confirmed", source: "asr", talkTimeMs: 0, wordCount: 0, segmentCount: 0 },
  { id: "spk_b", meetingId: "m1", label: "Speaker 2", mappingStatus: "unmapped", source: "asr", talkTimeMs: 0, wordCount: 0, segmentCount: 0 },
]

/** Labels every requested turn: even turns positive, odd negative. */
function answerAll(request: LlmStructuredRequest<SentimentResponse>) {
  const aliases = [...request.instructions.matchAll(/^\[(t\d+)\]/gm)].map((match) => match[1])

  return {
    value: {
      turns: aliases.map((alias) => {
        const n = Number(alias.slice(1))

        return n % 2 === 1 ? { turn: alias, label: "positive", score: 0.8 } : { turn: alias, label: "negative", score: -0.6 }
      }),
    },
    provider: "anthropic",
    model: "claude-haiku-5-5",
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    costUsd: 0,
    latencyMs: 1,
    attempts: [],
    fallbackUsed: false,
    aiRunId: "run_1",
  }
}

const input = (segs: TranscriptSegment[], extra: Partial<Parameters<typeof analyzeSentiment>[0]> = {}) => ({
  workspaceId: "ws_1",
  meetingId: "m1",
  segments: segs,
  speakers,
  language: "he",
  ...extra,
})

beforeEach(() => {
  generateStructured.mockReset()
  generateStructured.mockImplementation(async (request) => answerAll(request))
})

describe("buildSpeakerTurns", () => {
  it("merges consecutive segments of a speaker and truncates to 600 chars", () => {
    const turns = buildSpeakerTurns([
      { id: "a", speaker: "S1", speakerId: "x", startMs: 0, endMs: 1, text: "שלום" },
      { id: "b", speaker: "S1", speakerId: "x", startMs: 2, endMs: 3, text: "לכולם" },
      { id: "c", speaker: "S2", speakerId: "y", startMs: 4, endMs: 5, text: "א".repeat(700) },
    ])

    expect(turns.map((turn) => [turn.alias, turn.speakerKey, turn.text.length])).toEqual([
      ["t1", "x", 10],
      ["t2", "y", SENTIMENT_TURN_MAX_CHARS],
    ])
    expect(turns[0].hash).toMatch(/^[0-9a-f]{40}$/)
  })
})

describe("analyzeSentiment", () => {
  it("sends at most 40 turns per request through the sentiment task", async () => {
    const result = await analyzeSentiment(input(segments(95)))

    expect(generateStructured).toHaveBeenCalledTimes(3)
    const batches = generateStructured.mock.calls.map(([request]) => request as LlmStructuredRequest<SentimentResponse>)

    expect(batches.map((request) => [...request.instructions.matchAll(/^\[t\d+\]/gm)].length)).toEqual([
      SENTIMENT_BATCH_SIZE,
      SENTIMENT_BATCH_SIZE,
      15,
    ])
    expect(batches[0]).toMatchObject({
      task: "sentiment",
      language: "he",
      effort: "low",
      ctx: { workspaceId: "ws_1", meetingId: "m1", promptVersion: "m5.sentiment.1" },
    })
    expect(batches[0].instructions).toContain("ציניות")
    expect(result?.sentiment.turns).toHaveLength(95)
    expect(result?.aiRunId).toBe("run_1")
  })

  it("aggregates per speaker, per chapter and overall", async () => {
    const chapters: Chapter[] = [
      { id: "ch1", title: "א", summary: "", startMs: 0, endMs: 20_000, startSegmentId: "s0", bullets: [] },
      { id: "ch2", title: "ב", summary: "", startMs: 20_000, endMs: 40_000, startSegmentId: "s2", bullets: [] },
    ]
    const result = await analyzeSentiment(input(segments(4), { chapters }))
    const sentiment = result!.sentiment

    expect(sentiment.bySpeaker).toEqual([
      { speakerKey: "spk_a", speakerId: "spk_a", speakerLabel: "Speaker 1", displayName: "דנה", label: "positive", score: 0.8, turns: 2 },
      { speakerKey: "spk_b", speakerId: "spk_b", speakerLabel: "Speaker 2", displayName: undefined, label: "negative", score: -0.6, turns: 2 },
    ])
    expect(sentiment.byChapter).toEqual([
      { chapterId: "ch1", label: "mixed", score: 0.1, turns: 2 },
      { chapterId: "ch2", label: "mixed", score: 0.1, turns: 2 },
    ])
    expect(sentiment.overall).toEqual({ label: "mixed", score: 0.1, turns: 4 })
    expect(sentiment.provider).toBe("anthropic")
    expect(JSON.stringify(sentiment)).not.toContain("תור מספר")
  })

  it("only sends turns whose text hash is not cached", async () => {
    const first = await analyzeSentiment(input(segments(4)))

    generateStructured.mockClear()
    const changed = segments(4).map((segment) => (segment.id === "s3" ? { ...segment, text: "טקסט חדש" } : segment))
    const second = await analyzeSentiment(input(changed, { previous: first!.sentiment }))

    expect(generateStructured).toHaveBeenCalledTimes(1)
    const request = generateStructured.mock.calls[0][0] as LlmStructuredRequest<SentimentResponse>
    expect(request.instructions).toContain("טקסט חדש")
    expect(request.instructions).not.toContain("תור מספר 0")
    expect(second?.sentiment.turns).toHaveLength(4)
  })

  it("is non-fatal when a batch fails and drops unknown turn ids", async () => {
    let call = 0

    generateStructured.mockImplementation(async (request: LlmStructuredRequest<SentimentResponse>) => {
      call += 1
      if (call === 2) throw new LlmError("down", "server", "anthropic", true)
      const answer = answerAll(request)

      answer.value.turns.push({ turn: "t999", label: "positive", score: 5 })
      return answer
    })

    const result = await analyzeSentiment(input(segments(50)))

    expect(result?.sentiment.turns).toHaveLength(40)
    expect(result?.sentiment.failedTurns).toBe(10)
    const validate = (generateStructured.mock.calls[0][0] as LlmStructuredRequest<SentimentResponse>).validate!

    expect(validate({ turns: [{ turn: "t999", label: "neutral", score: 0 }] })).toEqual(["unknown turn id t999"])
  })

  it("returns undefined when every batch fails or there are no turns", async () => {
    generateStructured.mockRejectedValue(new LlmError("no key", "config", "none", false))

    expect(await analyzeSentiment(input(segments(3)))).toBeUndefined()
    expect(await analyzeSentiment(input([]))).toBeUndefined()
  })

  it("clamps scores into -1..1", async () => {
    generateStructured.mockResolvedValue({
      ...answerAll({ instructions: "" } as LlmStructuredRequest<SentimentResponse>),
      value: { turns: [{ turn: "t1", label: "positive", score: 7 }] },
    })

    const result = await analyzeSentiment(input(segments(1)))

    expect(result?.sentiment.turns?.[0].score).toBe(1)
  })
})

describe("reaggregateSentiment", () => {
  it("regroups cached turns after a speaker merge without an LLM call", async () => {
    const first = await analyzeSentiment(input(segments(4)))

    generateStructured.mockClear()
    const merged = segments(4).map((segment) => ({ ...segment, speaker: "Speaker 1", speakerId: "spk_a" }))
    const regrouped = reaggregateSentiment(first!.sentiment, { segments: merged, speakers })

    expect(generateStructured).not.toHaveBeenCalled()
    // All four segments are now one turn whose text is new: nothing cached.
    expect(regrouped).toBeUndefined()
    const renamed = reaggregateSentiment(first!.sentiment, {
      segments: segments(4),
      speakers: [{ ...speakers[0], displayName: "דנה כהן" }, speakers[1]],
    })

    expect(renamed?.bySpeaker[0].displayName).toBe("דנה כהן")
    expect(renamed?.bySpeaker[0].turns).toBe(2)
  })
})

describe("aggregateSentiment / isSentimentEnabled", () => {
  it("defaults to neutral", () => {
    expect(aggregateSentiment([])).toEqual({ label: "neutral", score: 0, turns: 0 })
    expect(aggregateSentiment([{ label: "neutral", score: 0.1 }]).label).toBe("neutral")
  })

  it("honours the env kill switch and the workspace setting", () => {
    expect(isSentimentEnabled({})).toBe(true)
    expect(isSentimentEnabled({ aiFeatures: { sentiment: false } })).toBe(false)
    expect(isSentimentEnabled({}, { MEETSUM_SENTIMENT_ENABLED: "false" })).toBe(false)
  })
})
