import { describe, expect, it } from "vitest"

import { speakerColors } from "@/components/speaker-display"
import {
  assignSpeakerColors,
  speakerColorVar,
} from "@/lib/player/speaker-colors"
import {
  buildSpeakerRuns,
  buildTalkTimeRows,
  longestMonologueMs,
} from "@/lib/player/speaker-timeline"
import type { MeetingSpeaker } from "@/lib/meetings/repository"

const seg = (startMs: number, endMs: number, speakerId: string) => ({
  startMs,
  endMs,
  speaker: speakerId.toUpperCase(),
  speakerId,
})

function speaker(overrides: Partial<MeetingSpeaker> & { id: string; label: string }): MeetingSpeaker {
  return {
    meetingId: "m",
    mappingStatus: "unmapped",
    source: "asr",
    talkTimeMs: 0,
    wordCount: 0,
    segmentCount: 0,
    ...overrides,
  }
}

describe("buildSpeakerRuns", () => {
  it("orders lanes by first speech and merges small gaps", () => {
    const lanes = buildSpeakerRuns([
      seg(5_000, 6_000, "b"),
      seg(0, 1_000, "a"),
      seg(2_000, 3_000, "a"), // gap 1000 ≤ 1500 → merged
      seg(6_000, 7_000, "a"), // gap 3000 → new run
    ])

    expect(lanes.map((lane) => lane.key)).toEqual(["a", "b"])
    expect(lanes[0].runs).toEqual([
      { startMs: 0, endMs: 3_000 },
      { startMs: 6_000, endMs: 7_000 },
    ])
    expect(lanes[0].talkMs).toBe(3_000)
    expect(lanes[1].runs).toEqual([{ startMs: 5_000, endMs: 6_000 }])
  })

  it("keys legacy segments without speaker ids by label and skips empty spans", () => {
    const lanes = buildSpeakerRuns([
      { startMs: 0, endMs: 1_000, speaker: "Dana" },
      { startMs: 1_000, endMs: 1_000, speaker: "Ran" },
    ])

    expect(lanes).toHaveLength(1)
    expect(lanes[0]).toMatchObject({ key: "label:Dana", label: "Dana" })
  })

  it("uses the stored speaker label when known", () => {
    const lanes = buildSpeakerRuns([seg(0, 1_000, "a")], [speaker({ id: "a", label: "Speaker 1" })])

    expect(lanes[0].label).toBe("Speaker 1")
  })
})

describe("longestMonologueMs", () => {
  it("measures consecutive same-speaker stretches", () => {
    const result = longestMonologueMs([
      seg(0, 10_000, "a"),
      seg(11_000, 20_000, "a"),
      seg(20_000, 25_000, "b"),
      seg(25_000, 30_000, "a"),
    ])

    expect(result.get("a")).toBe(20_000)
    expect(result.get("b")).toBe(5_000)
  })
})

describe("buildTalkTimeRows", () => {
  it("sorts by talk time, hides silent speakers and computes share, WPM and monologue", () => {
    const rows = buildTalkTimeRows(
      [
        speaker({ id: "a", label: "Speaker 1", talkTimeMs: 60_000, wordCount: 150 }),
        speaker({ id: "b", label: "Speaker 2", talkTimeMs: 180_000, wordCount: 0 }),
        speaker({ id: "c", label: "Speaker 3", talkTimeMs: 0 }),
      ],
      [seg(0, 60_000, "a"), seg(60_000, 240_000, "b")]
    )

    expect(rows.map((row) => row.speakerId)).toEqual(["b", "a"])
    expect(rows[0].share).toBeCloseTo(0.75)
    expect(rows[0].wpm).toBeUndefined()
    expect(rows[1].wpm).toBe(150)
    expect(rows[0].longestMonologueMs).toBe(180_000)
  })
})

describe("speaker colours", () => {
  it("assigns palette slots by first speech, matching the mapping panel", () => {
    const speakers = [
      speaker({ id: "late", label: "Speaker 2", firstStartMs: 9_000 }),
      speaker({ id: "early", label: "Speaker 1", firstStartMs: 1_000 }),
      speaker({ id: "never", label: "Speaker 3" }),
    ]
    const colors = assignSpeakerColors(speakers)

    expect([...colors.entries()]).toEqual([...speakerColors(speakers).entries()])
    expect(colors.get("early")).toBe(1)
    expect(speakerColorVar(colors.get("late")!)).toBe("var(--spk-2)")
  })

  it("wraps after eight speakers", () => {
    const many = Array.from({ length: 9 }, (_, index) =>
      speaker({ id: `s${index}`, label: `Speaker ${index + 1}`, firstStartMs: index })
    )

    expect(assignSpeakerColors(many).get("s8")).toBe(1)
  })
})
