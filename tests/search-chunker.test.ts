import { describe, expect, it } from "vitest"

import { estimateTokens } from "@/lib/intelligence/transcript-format"
import type { MeetingSpeaker, TranscriptSegment } from "@/lib/meetings/repository"
import { chunkTranscript } from "@/lib/search/chunker"

const SENTENCE = "דיברנו על התקציב של הרבעון ועל ההשקה הקרובה בשוק המקומי."

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

const speakers = [speaker("sp_a", "Speaker 1", "דנה"), speaker("sp_b", "Speaker 2", "Avi")]

/** `count` segments alternating speakers every `perTurn` segments. */
function segments(count: number, perTurn = 2, text = SENTENCE): TranscriptSegment[] {
  return Array.from({ length: count }, (_, index) => {
    const turn = Math.floor(index / perTurn)
    const spk = turn % 2 === 0 ? "sp_a" : "sp_b"

    return {
      id: `seg_${index}`,
      speaker: spk === "sp_a" ? "Speaker 1" : "Speaker 2",
      speakerId: spk,
      turnIndex: turn,
      startMs: index * 5_000,
      endMs: index * 5_000 + 4_000,
      text: `${text} (${index})`,
      language: "he",
    }
  })
}

describe("chunkTranscript", () => {
  it("returns nothing for an empty transcript", () => {
    expect(chunkTranscript({ segments: [], speakers })).toEqual([])
  })

  it("builds turn lines with display names and segment offsets", () => {
    const [chunk] = chunkTranscript({ segments: segments(4), speakers, meetingLanguage: "he" })

    expect(chunk.kind).toBe("transcript")
    expect(chunk.chunkIndex).toBe(0)
    expect(chunk.text.split("\n")).toHaveLength(2)
    expect(chunk.text.startsWith("דנה: ")).toBe(true)
    expect(chunk.text.split("\n")[1].startsWith("Avi: ")).toBe(true)
    expect(chunk.segmentIds).toEqual(["seg_0", "seg_1", "seg_2", "seg_3"])
    expect(chunk.segmentStartMs).toEqual([0, 5_000, 10_000, 15_000])
    chunk.segmentIds.forEach((id, index) => {
      expect(chunk.text.slice(chunk.segmentOffsets[index]).startsWith(`${SENTENCE} (${id.slice(4)})`)).toBe(true)
    })
    expect(chunk.speakerIds).toEqual(["sp_a", "sp_b"])
    expect(chunk.startMs).toBe(0)
    expect(chunk.endMs).toBe(19_000)
    expect(chunk.language).toBe("he")
    expect(chunk.overlapCount).toBe(0)
    expect(chunk.tokenEstimate).toBe(estimateTokens(chunk.text))
    expect(chunk.textNorm).toContain("התקציב")
    expect(chunk.textStem).toContain("תקציב")
    expect(chunk.contentHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it("merges whole turns until the minimum, then closes at a turn boundary", () => {
    const chunks = chunkTranscript({ segments: segments(60), speakers }, { minTokens: 100, maxTokens: 400, overlapTokens: 0 })

    expect(chunks.length).toBeGreaterThan(2)
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.tokenEstimate).toBeGreaterThanOrEqual(100)
      // Two segments per turn: own chunks never split a turn.
      expect(chunk.segmentIds.length % 2).toBe(0)
    }
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(chunks.map((_, index) => index))
  })

  it("never exceeds the maximum and splits a long turn at segment boundaries, repeating the label", () => {
    const chunks = chunkTranscript({ segments: segments(80, 80), speakers }, { minTokens: 250, maxTokens: 800, overlapTokens: 80 })

    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.tokenEstimate).toBeLessThanOrEqual(800)
      expect(chunk.text.startsWith("דנה: ")).toBe(true)
    }
  })

  it("splits a single oversize segment at sentences, then words, sharing the segment id", () => {
    const huge = Array.from({ length: 200 }, (_, index) => `משפט מספר ${index} על התקציב.`).join(" ")
    const giantWords = Array.from({ length: 900 }, () => "מילה").join(" ")
    const chunks = chunkTranscript(
      {
        segments: [
          { id: "big", speaker: "Speaker 1", speakerId: "sp_a", startMs: 0, endMs: 60_000, text: huge },
          { id: "words", speaker: "Speaker 1", speakerId: "sp_a", startMs: 60_000, endMs: 90_000, text: giantWords },
        ],
        speakers,
      },
      { maxTokens: 300, minTokens: 100, overlapTokens: 0 }
    )

    expect(chunks.length).toBeGreaterThan(3)
    for (const chunk of chunks) expect(chunk.tokenEstimate).toBeLessThanOrEqual(300)
    const bigPieces = chunks.flatMap((chunk) =>
      chunk.segmentIds.map((id, index) => ({ id, offset: chunk.segmentOffsets[index], chunk }))
    )

    expect(bigPieces.filter((piece) => piece.id === "big").length).toBeGreaterThan(1)
    expect(bigPieces.filter((piece) => piece.id === "words").length).toBeGreaterThan(1)
    // Sentence split: every "big" piece starts at a sentence start.
    for (const piece of bigPieces.filter((p) => p.id === "big")) {
      expect(piece.chunk.text.slice(piece.offset).startsWith("משפט")).toBe(true)
    }
  })

  it("prepends trailing segments of the previous chunk as overlap", () => {
    const chunks = chunkTranscript({ segments: segments(60), speakers }, { minTokens: 150, maxTokens: 400, overlapTokens: 60 })

    expect(chunks[0].overlapCount).toBe(0)
    for (let index = 1; index < chunks.length; index += 1) {
      const chunk = chunks[index]
      const previous = chunks[index - 1]
      const overlapIds = chunk.segmentIds.slice(0, chunk.overlapCount)
      const previousOwn = previous.segmentIds.slice(previous.overlapCount)

      expect(chunk.overlapCount).toBeGreaterThan(0)
      expect(previousOwn.slice(-overlapIds.length)).toEqual(overlapIds)
      // start/end cover the chunk's own segments only.
      const ownFirst = chunk.segmentIds[chunk.overlapCount]

      expect(chunk.startMs).toBe(Number(ownFirst.slice(4)) * 5_000)
      expect(chunk.tokenEstimate).toBeLessThanOrEqual(400)
    }
  })

  it("is deterministic", () => {
    const input = { segments: segments(50), speakers }

    expect(chunkTranscript(input)).toEqual(chunkTranscript(input))
  })

  it("changes at most two content hashes for a one-segment edit", () => {
    const original = segments(120)
    const edited = original.map((segment) =>
      segment.id === "seg_57" ? { ...segment, text: segment.text.replace("התקציב", "התכנון") } : segment
    )
    const before = chunkTranscript({ segments: original, speakers })
    const after = chunkTranscript({ segments: edited, speakers })
    const beforeHashes = new Set(before.map((chunk) => chunk.contentHash))
    const changed = after.filter((chunk) => !beforeHashes.has(chunk.contentHash))

    expect(before.length).toBeGreaterThan(4)
    expect(after).toHaveLength(before.length)
    expect(changed.length).toBeGreaterThan(0)
    expect(changed.length).toBeLessThanOrEqual(2)
  })

  it("falls back to speaker changes for legacy rows without turn_index", () => {
    const legacy: TranscriptSegment[] = [
      { id: "l1", speaker: "Speaker 1", startMs: 0, endMs: 1_000, text: "שלום לכולם" },
      { id: "l2", speaker: "Speaker 1", startMs: 1_000, endMs: 2_000, text: "נתחיל בתקציב" },
      { id: "l3", speaker: "Speaker 2", startMs: 2_000, endMs: 3_000, text: "Sounds good" },
    ]
    const [chunk] = chunkTranscript({ segments: legacy, speakers: [], meetingLanguage: "he" })

    expect(chunk.text).toBe("Speaker 1: שלום לכולם נתחיל בתקציב\nSpeaker 2: Sounds good")
    expect(chunk.speakerIds).toEqual([])
    expect(chunk.segmentOffsets).toEqual([11, 22, 46])
  })

  it("takes the majority segment language, falling back to the meeting language", () => {
    const mixed: TranscriptSegment[] = [
      { id: "a", speaker: "A", startMs: 0, endMs: 1, text: "hello", language: "en" },
      { id: "b", speaker: "A", startMs: 1, endMs: 2, text: "world", language: "en" },
      { id: "c", speaker: "A", startMs: 2, endMs: 3, text: "שלום", language: "he" },
    ]

    expect(chunkTranscript({ segments: mixed, speakers: [] })[0].language).toBe("en")
    expect(
      chunkTranscript({
        segments: mixed.map(({ language, ...segment }) => (void language, segment)),
        speakers: [],
        meetingLanguage: "he",
      })[0].language
    ).toBe("he")
  })
})
