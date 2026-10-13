import { describe, expect, it } from "vitest"

import { DEFAULT_ASR_GLOSSARY } from "@/lib/ai/asr"
import {
  assignLanguage,
  buildSegments,
  fillMissingSpeakers,
  finalizeResult,
  joinWords,
  relabelSpeakers,
  summarizeSpeakers,
  synthesizeWords,
  type AsrDraft,
} from "@/lib/ai/asr/segmentation"
import type { AsrWord } from "@/lib/ai/asr/types"

function w(text: string, startMs: number, endMs: number, speaker?: string, extra: Partial<AsrWord> = {}): AsrWord {
  return { text, startMs, endMs, ...(speaker ? { speaker } : {}), ...extra }
}

function draft(words: AsrWord[], overrides: Partial<AsrDraft> = {}): AsrDraft {
  return {
    provider: "runpod-ivrit",
    model: "test",
    language: "he",
    durationMs: 10_000,
    words,
    diarization: "provider",
    cost: { usd: 0, basis: "none" },
    timings: {},
    warnings: [],
    ...overrides,
  }
}

describe("speakers", () => {
  it("relabels raw provider labels by first appearance", () => {
    const { words, mapping } = relabelSpeakers([w("a", 0, 1, "SPEAKER_07"), w("b", 1, 2, "SPEAKER_02"), w("c", 2, 3, "SPEAKER_07")])

    expect(words.map((word) => word.speaker)).toEqual(["Speaker 1", "Speaker 2", "Speaker 1"])
    expect([...mapping.entries()]).toEqual([
      ["SPEAKER_07", "Speaker 1"],
      ["SPEAKER_02", "Speaker 2"],
    ])
  })

  it("fills missing speakers from the previous word, else the next", () => {
    const filled = fillMissingSpeakers([w("a", 0, 1), w("b", 1, 2, "B"), w("c", 2, 3), w("d", 3, 4, "C")])

    expect(filled.map((word) => word.speaker)).toEqual(["B", "B", "B", "C"])
    expect(fillMissingSpeakers([w("x", 0, 1)])[0].speaker).toBe("Speaker 1")
  })
})

describe("assignLanguage", () => {
  it("detects Hebrew/Latin by script; digits inherit; provider tags win", () => {
    const words = assignLanguage(
      [w("2026", 0, 1), w("שלום", 1, 2), w("Supabase", 2, 3), w("42", 3, 4), w("ok", 4, 5, undefined, { language: "pt" })],
      "he"
    )

    expect(words.map((word) => word.language)).toEqual(["he", "he", "en", "en", "pt"])
  })

  it("treats Latin script as the meeting language outside Hebrew", () => {
    expect(assignLanguage([w("olá", 0, 1), w("123", 1, 2)], "pt-BR").map((word) => word.language)).toEqual(["pt", "pt"])
    expect(assignLanguage([w("123", 0, 1)], "mixed")[0].language).toBe("he")
  })
})

describe("buildSegments", () => {
  it("splits on speaker change and increments turnIndex only then", () => {
    const segments = buildSegments(
      [w("a", 0, 500, "S1"), w("b", 500, 900, "S1"), w("c", 1000, 1400, "S2"), w("d", 5000, 5400, "S2"), w("e", 5500, 5900, "S1")],
      "he"
    )

    expect(segments.map((segment) => [segment.speaker, segment.turnIndex, segment.text])).toEqual([
      ["S1", 0, "a b"],
      ["S2", 1, "c"],
      ["S2", 1, "d"],
      ["S1", 2, "e"],
    ])
  })

  it("splits after 80 words", () => {
    const words = Array.from({ length: 81 }, (_, index) => w(`מילה${index}`, index * 100, index * 100 + 90, "S1"))
    const segments = buildSegments(words, "he")

    expect(segments.map((segment) => segment.words.length)).toEqual([80, 1])
    expect(new Set(segments.map((segment) => segment.turnIndex))).toEqual(new Set([0]))
  })

  it("closes past 25 s at a sentence break and hard-caps at 40 s", () => {
    const words: AsrWord[] = []

    for (let second = 0; second < 50; second += 1) {
      words.push(w(second === 26 ? "סוף." : "מילה", second * 1000, second * 1000 + 900, "S1"))
    }

    const segments = buildSegments(words, "he")

    // 0..26 (sentence break after 25 s), then 27.. up to the 40 s hard cap.
    expect(segments[0].words.at(-1)?.text).toBe("סוף.")
    expect(segments[0].endMs).toBe(26_900)
    expect(segments[1].startMs).toBe(27_000)
    expect(segments[1].endMs - segments[1].startMs).toBeLessThanOrEqual(40_000)
    expect(segments.length).toBe(2)
  })

  it("hard-cuts at 40 s without a sentence break", () => {
    const words = Array.from({ length: 50 }, (_, second) => w("מילה", second * 1000, second * 1000 + 900, "S1"))
    const segments = buildSegments(words, "he")

    expect(segments.map((segment) => segment.words.length)).toEqual([40, 10])
    expect(segments[0].endMs - segments[0].startMs).toBeLessThanOrEqual(40_000)
  })

  it("computes text, mean confidence and majority language", () => {
    const [segment] = buildSegments(
      [
        w("שלום", 0, 300, "S1", { confidence: 0.9, language: "he" }),
        w(",", 300, 310, "S1", { confidence: 0.7, language: "he" }),
        w("Supabase", 400, 900, "S1", { language: "en" }),
        w("?", 900, 910, "S1", { language: "he" }),
      ],
      "he"
    )

    expect(segment.text).toBe("שלום, Supabase?")
    expect(segment.confidence).toBe(0.8)
    expect(segment.language).toBe("he")
  })
})

describe("helpers", () => {
  it("joins words without spaces before closing punctuation", () => {
    expect(joinWords([w("היי", 0, 1), w(",", 1, 2), w("מה", 2, 3), w("?", 3, 4), w("כן", 4, 5), w(".", 5, 6)])).toBe(
      "היי, מה? כן."
    )
  })

  it("summarizes speakers with talk time, counts and embeddings", () => {
    const segments = buildSegments([w("a", 0, 1000, "Speaker 1"), w("b", 1200, 2000, "Speaker 2"), w("c", 2100, 3100, "Speaker 1")], "he")
    const speakers = summarizeSpeakers(segments, new Map([["Speaker 2", { embedding: [1, 2], model: "m" }]]))

    expect(speakers).toEqual([
      { label: "Speaker 1", talkTimeMs: 2000, wordCount: 2, segmentCount: 2, firstStartMs: 0 },
      { label: "Speaker 2", talkTimeMs: 800, wordCount: 1, segmentCount: 1, firstStartMs: 1200, embedding: [1, 2], embeddingModel: "m" },
    ])
  })

  it("synthesizes evenly spread word timings", () => {
    const words = synthesizeWords("אחת שתיים", 1000, 2000, { speaker: "S" })

    expect(words).toHaveLength(2)
    expect(words[0]).toMatchObject({ text: "אחת", startMs: 1000, speaker: "S" })
    expect(words[1]).toMatchObject({ text: "שתיים", endMs: 2000 })
    expect(words[0].endMs).toBe(words[1].startMs)
  })
})

describe("finalizeResult", () => {
  it("relabels, applies the glossary, assigns languages and maps embeddings", () => {
    const result = finalizeResult(
      draft(
        [
          w("עוברים", 500, 900, "SPEAKER_01", { confidence: 0.9 }),
          w("בסופבייס", 900, 1600, "SPEAKER_01", { confidence: 0.6 }),
          w("מעולה", 3000, 3500, "SPEAKER_00"),
        ],
        { speakerEmbeddings: { SPEAKER_00: { embedding: [0.5], model: "pyannote" } } }
      ),
      DEFAULT_ASR_GLOSSARY
    )

    expect(result.diarization).toBe("provider")
    expect(result.glossaryReplacements).toBe(1)
    expect(result.segments.map((segment) => [segment.speaker, segment.text])).toEqual([
      ["Speaker 1", "עוברים ב-Supabase"],
      ["Speaker 2", "מעולה"],
    ])
    expect(result.segments[0].words[1]).toMatchObject({ text: "ב-Supabase", startMs: 900, endMs: 1600, language: "en" })
    expect(result.speakers[1]).toMatchObject({ label: "Speaker 2", embedding: [0.5], embeddingModel: "pyannote" })
    expect(result.durationMs).toBe(10_000)
  })

  it("puts everyone on Speaker 1 with a warning when there is no diarization", () => {
    const result = finalizeResult(draft([w("a", 0, 100, "X"), w("b", 200, 300, "Y")], { diarization: "none" }), {
      version: 1,
      terms: [],
    })

    expect(result.diarization).toBe("none")
    expect(result.speakers.map((speaker) => speaker.label)).toEqual(["Speaker 1"])
    expect(result.warnings).toContain("diarization_unavailable")
  })

  it("drops empty words, sorts by time and clamps bad timings", () => {
    const result = finalizeResult(
      draft([w("שני", 2000, 1500, "A"), w("  ", 0, 10, "A"), w("ראשון", 1000, 1200, "A", { confidence: 3 })], { durationMs: 0 }),
      { version: 1, terms: [] }
    )

    expect(result.segments[0].words.map((word) => [word.text, word.startMs, word.endMs])).toEqual([
      ["ראשון", 1000, 1200],
      ["שני", 2000, 2000],
    ])
    expect(result.segments[0].words[0].confidence).toBe(1)
    expect(result.durationMs).toBe(2000)
  })
})
