import { describe, expect, it } from "vitest"

import { normalizeChapters } from "@/lib/intelligence/chapters"
import { formatTranscriptForPrompt } from "@/lib/intelligence/transcript-format"
import type { TranscriptSegment } from "@/lib/meetings/repository"

const MIN = 60_000

function segment(index: number, startMin: number): TranscriptSegment {
  return {
    id: `seg_${index}`,
    speaker: "דנה",
    startMs: startMin * MIN,
    endMs: startMin * MIN + 30_000,
    text: `קטע ${index}`,
  }
}

// s1..s8 at minutes 1, 5, 6, 12, 20, 21, 35, 59.
const segments = [1, 5, 6, 12, 20, 21, 35, 59].map((minute, index) => segment(index + 1, minute))
const transcript = formatTranscriptForPrompt(segments)

describe("chapter normalization", () => {
  it("snaps the first chapter to the first segment and ends each at the next start", () => {
    const chapters = normalizeChapters(
      [
        { title: "פתיחה", startRef: "s2", summary: "a", bullets: ["x"] },
        { title: "תקציב", startRef: "s4", summary: "b", bullets: [] },
        { title: "סיכום", startRef: "s7", summary: "c", bullets: [] },
      ],
      transcript
    )

    expect(chapters.map((chapter) => [chapter.title, chapter.startMs, chapter.endMs, chapter.startSegmentId])).toEqual([
      ["פתיחה", 1 * MIN, 12 * MIN, "seg_1"],
      ["תקציב", 12 * MIN, 35 * MIN, "seg_4"],
      ["סיכום", 35 * MIN, 59 * MIN + 30_000, "seg_7"],
    ])
    expect(new Set(chapters.map((chapter) => chapter.id)).size).toBe(3)
  })

  it("sorts out-of-order chapters into monotonic starts", () => {
    const chapters = normalizeChapters(
      [
        { title: "C", startRef: "s7" },
        { title: "A", startRef: "s1" },
        { title: "B", startRef: "s5" },
      ],
      transcript
    )

    expect(chapters.map((chapter) => chapter.title)).toEqual(["A", "B", "C"])
    for (let index = 1; index < chapters.length; index += 1) {
      expect(chapters[index].startMs).toBeGreaterThan(chapters[index - 1].startMs)
      expect(chapters[index - 1].endMs).toBe(chapters[index].startMs)
    }
  })

  it("drops unknown aliases and merges chapters shorter than 2 minutes", () => {
    const chapters = normalizeChapters(
      [
        { title: "A", startRef: "s1", bullets: ["a"] },
        { title: "Ghost", startRef: "s404" },
        { title: "Too close", startRef: "s5", bullets: ["b"] },
        { title: "Also close", startRef: "s6", bullets: ["c"] },
      ],
      transcript
    )

    expect(chapters.map((chapter) => chapter.title)).toEqual(["A", "Too close"])
    expect(chapters[1].bullets).toEqual(["b", "c"])
  })

  it("covers the transcript to the media end when known", () => {
    const chapters = normalizeChapters([{ title: "Only", startRef: "s3" }], transcript, {
      endMs: 62 * MIN,
    })

    expect(chapters).toHaveLength(1)
    expect(chapters[0]).toMatchObject({ startMs: 1 * MIN, endMs: 62 * MIN })
  })

  it("returns nothing for no resolvable chapters", () => {
    expect(normalizeChapters([{ title: "x", startRef: "nope" }], transcript)).toEqual([])
  })
})
