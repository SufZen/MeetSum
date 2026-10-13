import { describe, expect, it } from "vitest"

import {
  computeMeetingAnalytics,
  refreshSpeakerNames,
  transcriptHash,
} from "@/lib/analytics/compute"
import type { MeetingSpeaker, TranscriptSegment } from "@/lib/meetings/repository"
import type { TranscriptWord } from "@/lib/meetings/transcript-words"

function words(text: string, startMs: number): TranscriptWord[] {
  return text.split(" ").map((word, index) => ({
    startMs: startMs + index * 100,
    endMs: startMs + index * 100 + 90,
    text: word,
  }))
}

function seg(
  id: string,
  speakerId: string,
  startMs: number,
  endMs: number,
  text: string,
  rawWords?: string
): TranscriptSegment {
  return {
    id,
    speaker: speakerId === "spk_dana" ? "Speaker 1" : "Speaker 2",
    speakerId,
    startMs,
    endMs,
    text,
    words: rawWords === undefined ? undefined : words(rawWords, startMs),
  }
}

function speaker(id: string, label: string, displayName?: string): MeetingSpeaker {
  return {
    id,
    meetingId: "m1",
    label,
    displayName,
    mappingStatus: displayName ? "confirmed" : "unmapped",
    source: "asr",
    talkTimeMs: 0,
    wordCount: 0,
    segmentCount: 0,
  }
}

const speakers = [speaker("spk_dana", "Speaker 1", "דנה"), speaker("spk_avi", "Speaker 2")]

/**
 * Dana: 0–30s, 31–60s (one 60 s monologue, gap 1 s), 120–150s.
 * Avi: 59.9–120s (interrupts Dana: starts 100 ms before she ends), 151–180s.
 * Dana then starts right as Avi ends (back-to-back: not an interruption).
 * Raw words keep fillers that the cleaned text dropped.
 */
const fixture: TranscriptSegment[] = [
  seg("s1", "spk_dana", 0, 30_000, "שלום לכולם, נתחיל", "אה שלום לכולם נתחיל"),
  seg("s2", "spk_dana", 31_000, 60_000, "מה הסטטוס של ה-API?", "מה הסטטוס של כאילו ה-API"),
  seg("s3", "spk_avi", 59_900, 120_000, "הכל מוכן. Do you want a demo?", "um הכל מוכן Do you want a demo"),
  seg("s4", "spk_dana", 120_000, 150_000, "כן", "כן"),
  seg("s5", "spk_avi", 151_000, 180_000, "מעולה, נשלח מחר", "מעולה נשלח מחר"),
]

describe("computeMeetingAnalytics", () => {
  it("computes per-speaker metrics from raw words", () => {
    const metrics = computeMeetingAnalytics(fixture, speakers)
    const [dana, avi] = metrics.speakers

    expect(metrics.basis).toBe("words")
    expect(metrics.totalTalkTimeMs).toBe(178_100)
    expect(dana).toMatchObject({
      speakerId: "spk_dana",
      label: "Speaker 1",
      displayName: "דנה",
      talkTimeMs: 89_000,
      wordCount: 10,
      longestMonologueMs: 60_000,
      questions: 1,
      interruptions: 0,
      // אה + כאילו out of 10 words
      fillerPer100Words: 20,
    })
    expect(dana.share).toBeCloseTo(89_000 / 178_100, 4)
    expect(dana.wpm).toBeCloseTo(10 / (89_000 / 60_000), 1)
    expect(avi).toMatchObject({
      speakerId: "spk_avi",
      label: "Speaker 2",
      talkTimeMs: 89_100,
      wordCount: 11,
      longestMonologueMs: 60_100,
      questions: 1,
      interruptions: 1,
    })
    expect(avi.fillerPer100Words).toBeCloseTo((1 / 11) * 100, 2)
    expect(metrics.totalWords).toBe(21)
    expect(metrics.totalQuestions).toBe(2)
    expect(metrics.interruptions).toBe(1)
    expect(metrics.fillerPer100Words).toBeCloseTo((3 / 21) * 100, 2)
  })

  it("counts an interruption only on overlap, not on back-to-back or short-gap turns", () => {
    const metrics = computeMeetingAnalytics(
      [
        { id: "a", speaker: "A", startMs: 0, endMs: 1000, text: "one" },
        { id: "b", speaker: "B", startMs: 1000, endMs: 2000, text: "two" },
        { id: "c", speaker: "A", startMs: 2100, endMs: 3000, text: "three" },
        { id: "d", speaker: "B", startMs: 2900, endMs: 4000, text: "four" },
      ],
      []
    )

    expect(metrics.speakers.map((entry) => [entry.label, entry.interruptions])).toEqual([
      ["A", 0],
      ["B", 1],
    ])
  })

  it("falls back to segment text when any segment has no words", () => {
    const metrics = computeMeetingAnalytics(
      fixture.map((segment, index) => (index === 0 ? { ...segment, words: undefined } : segment)),
      speakers
    )

    expect(metrics.basis).toBe("text")
    // Cleaned text has no fillers left.
    expect(metrics.fillerPer100Words).toBe(0)
  })

  it("keys legacy segments without speaker ids by label", () => {
    const metrics = computeMeetingAnalytics(
      [
        { id: "a", speaker: "Speaker A", startMs: 0, endMs: 1000, text: "hello there" },
        { id: "b", speaker: "Speaker B", startMs: 5000, endMs: 6000, text: "hi" },
        { id: "c", speaker: "Speaker A", startMs: 7000, endMs: 8000, text: "ok" },
      ],
      []
    )

    expect(metrics.speakers.map((entry) => [entry.label, entry.talkTimeMs, entry.interruptions])).toEqual([
      ["Speaker A", 2000, 0],
      ["Speaker B", 1000, 0],
    ])
  })

  it("returns empty totals for an empty transcript", () => {
    expect(computeMeetingAnalytics([], [])).toEqual({
      basis: "text",
      totalTalkTimeMs: 0,
      totalWords: 0,
      totalQuestions: 0,
      fillerPer100Words: 0,
      interruptions: 0,
      speakers: [],
    })
  })
})

describe("transcriptHash", () => {
  it("changes with text or speaker assignment and ignores order of input", () => {
    const hash = transcriptHash(fixture)

    expect(hash).toMatch(/^[0-9a-f]{40}$/)
    expect(transcriptHash([...fixture].reverse())).toBe(hash)
    expect(transcriptHash(fixture.map((s) => (s.id === "s4" ? { ...s, text: "לא" } : s)))).not.toBe(hash)
    expect(
      transcriptHash(fixture.map((s) => (s.id === "s4" ? { ...s, speakerId: "spk_avi" } : s)))
    ).not.toBe(hash)
  })
})

describe("refreshSpeakerNames", () => {
  it("applies renamed display names without recomputing", () => {
    const metrics = computeMeetingAnalytics(fixture, speakers)
    const renamed = refreshSpeakerNames(metrics, [
      speaker("spk_dana", "Speaker 1", "דנה כהן"),
      speaker("spk_avi", "Speaker 2", "Avi"),
    ])

    expect(renamed.speakers.map((entry) => entry.displayName)).toEqual(["דנה כהן", "Avi"])
    expect(renamed.speakers[0].talkTimeMs).toBe(metrics.speakers[0].talkTimeMs)
  })
})
