import { describe, expect, it } from "vitest"

import type { TranscriptSegment } from "@/lib/meetings/repository"

type SpeakerMapping = {
  speaker: string
  person: string
}

/**
 * Speaker-to-person assignment logic tests.
 * Tests the mapping algorithm independently of API routes.
 */

function applySpeakerMappings(
  segments: TranscriptSegment[],
  mappings: SpeakerMapping[]
): { updated: TranscriptSegment[]; changedCount: number } {
  const speakerMap = new Map<string, string>()

  for (const { speaker, person } of mappings) {
    speakerMap.set(speaker, person)
  }

  const updated = segments.map((segment) => {
    const person = speakerMap.get(segment.speaker)
    return person ? { ...segment, speaker: person } : segment
  })

  const changedCount = updated.filter(
    (s, i) => s.speaker !== segments[i].speaker
  ).length

  return { updated, changedCount }
}

function makeSeg(speaker: string, text: string): TranscriptSegment {
  return {
    id: `seg_${Math.random().toString(36).slice(2)}`,
    speaker,
    startMs: 0,
    endMs: 1000,
    text,
  }
}

describe("speaker assignment mapping", () => {
  it("replaces speaker labels with person names", () => {
    const segments = [
      makeSeg("Speaker 1", "Hello"),
      makeSeg("Speaker 2", "Hi"),
      makeSeg("Speaker 1", "How are you?"),
    ]

    const { updated, changedCount } = applySpeakerMappings(segments, [
      { speaker: "Speaker 1", person: "Alice" },
      { speaker: "Speaker 2", person: "Bob" },
    ])

    expect(updated[0].speaker).toBe("Alice")
    expect(updated[1].speaker).toBe("Bob")
    expect(updated[2].speaker).toBe("Alice")
    expect(changedCount).toBe(3)
  })

  it("preserves unmapped speakers", () => {
    const segments = [
      makeSeg("Speaker 1", "Hello"),
      makeSeg("Speaker 2", "Hi"),
      makeSeg("Speaker 3", "Hey"),
    ]

    const { updated, changedCount } = applySpeakerMappings(segments, [
      { speaker: "Speaker 1", person: "Alice" },
    ])

    expect(updated[0].speaker).toBe("Alice")
    expect(updated[1].speaker).toBe("Speaker 2")
    expect(updated[2].speaker).toBe("Speaker 3")
    expect(changedCount).toBe(1)
  })

  it("handles empty mappings", () => {
    const segments = [makeSeg("Speaker 1", "Hello")]
    const { updated, changedCount } = applySpeakerMappings(segments, [])

    expect(updated[0].speaker).toBe("Speaker 1")
    expect(changedCount).toBe(0)
  })

  it("handles empty transcript", () => {
    const { updated, changedCount } = applySpeakerMappings([], [
      { speaker: "Speaker 1", person: "Alice" },
    ])

    expect(updated).toHaveLength(0)
    expect(changedCount).toBe(0)
  })

  it("preserves all other segment properties", () => {
    const segment: TranscriptSegment = {
      id: "seg_test",
      speaker: "Speaker 1",
      startMs: 5000,
      endMs: 10000,
      text: "Important text",
      confidence: 0.95,
      language: "he",
    }

    const { updated } = applySpeakerMappings([segment], [
      { speaker: "Speaker 1", person: "Alice" },
    ])

    expect(updated[0]).toEqual({
      ...segment,
      speaker: "Alice",
    })
  })

  it("handles duplicate speaker mappings (last wins)", () => {
    const segments = [makeSeg("Speaker 1", "Hello")]

    const { updated } = applySpeakerMappings(segments, [
      { speaker: "Speaker 1", person: "Alice" },
      { speaker: "Speaker 1", person: "Bob" },
    ])

    expect(updated[0].speaker).toBe("Bob")
  })

  it("does not change segments when speaker label does not match", () => {
    const segments = [makeSeg("David", "Already named")]

    const { updated, changedCount } = applySpeakerMappings(segments, [
      { speaker: "Speaker 1", person: "Alice" },
    ])

    expect(updated[0].speaker).toBe("David")
    expect(changedCount).toBe(0)
  })

  it("handles many segments efficiently", () => {
    const segments = Array.from({ length: 500 }, (_, i) =>
      makeSeg(`Speaker ${(i % 5) + 1}`, `Segment ${i}`)
    )

    const mappings = Array.from({ length: 5 }, (_, i) => ({
      speaker: `Speaker ${i + 1}`,
      person: `Person ${String.fromCharCode(65 + i)}`,
    }))

    const { changedCount } = applySpeakerMappings(segments, mappings)

    expect(changedCount).toBe(500)
  })
})

describe("speaker list extraction", () => {
  it("counts segments per speaker", () => {
    const segments = [
      makeSeg("Speaker 1", "A"),
      makeSeg("Speaker 2", "B"),
      makeSeg("Speaker 1", "C"),
      makeSeg("Speaker 1", "D"),
      makeSeg("Speaker 2", "E"),
    ]

    const speakers = new Map<string, number>()

    for (const segment of segments) {
      speakers.set(segment.speaker, (speakers.get(segment.speaker) ?? 0) + 1)
    }

    const sorted = [...speakers.entries()]
      .map(([label, segmentCount]) => ({ label, segmentCount }))
      .sort((a, b) => b.segmentCount - a.segmentCount)

    expect(sorted).toEqual([
      { label: "Speaker 1", segmentCount: 3 },
      { label: "Speaker 2", segmentCount: 2 },
    ])
  })
})
