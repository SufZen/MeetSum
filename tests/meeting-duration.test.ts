import { describe, expect, it } from "vitest"

import {
  formatDurationLabel,
  formatSpokenDuration,
  formatTimestamp,
  getMeetingDurationMs,
  meetingDurationLabel,
} from "@/lib/meetings/duration"
import type { MediaAsset, TranscriptSegment } from "@/lib/meetings/repository"

function asset(metadata: Record<string, unknown>): MediaAsset {
  return {
    id: "asset-1",
    meetingId: "m-1",
    storageKey: "k",
    contentType: "audio/webm",
    sizeBytes: 1,
    retention: "audio",
    kind: "original",
    metadata,
    createdAt: "2026-01-01T00:00:00.000Z",
  }
}

function segment(endMs: number): TranscriptSegment {
  return { id: `s-${endMs}`, speaker: "A", startMs: 0, endMs, text: "hi" }
}

const conference = {
  id: "c-1",
  conferenceRecordName: "conferenceRecords/1",
  startTime: "2026-01-01T10:00:00.000Z",
  endTime: "2026-01-01T10:30:00.000Z",
  artifacts: [],
}

describe("getMeetingDurationMs", () => {
  it("prefers the denormalized meeting duration (M4)", () => {
    expect(
      getMeetingDurationMs({
        durationMs: 300_000,
        mediaAssets: [asset({ durationMs: 125_000 })],
        transcript: [segment(90_000)],
      })
    ).toBe(300_000)
  })

  it("uses the probed asset duration column before metadata", () => {
    expect(
      getMeetingDurationMs({ mediaAssets: [{ ...asset({ durationMs: 1000 }), durationMs: 61_000 }] })
    ).toBe(61_000)
  })

  it("prefers media asset duration metadata", () => {
    expect(
      getMeetingDurationMs({
        mediaAssets: [asset({ durationMs: 125_000 })],
        transcript: [segment(90_000)],
        meetConferenceRecords: [conference],
      })
    ).toBe(125_000)
  })

  it("accepts durationSeconds metadata", () => {
    expect(getMeetingDurationMs({ mediaAssets: [asset({ durationSeconds: 60 })] })).toBe(60_000)
  })

  it("falls back to the latest transcript segment end", () => {
    expect(
      getMeetingDurationMs({
        mediaAssets: [asset({})],
        transcript: [segment(30_000), segment(95_000), segment(80_000)],
      })
    ).toBe(95_000)
  })

  it("falls back to Meet conference start/end", () => {
    expect(getMeetingDurationMs({ meetConferenceRecords: [conference] })).toBe(30 * 60_000)
  })

  it("returns undefined when nothing is known", () => {
    expect(getMeetingDurationMs({})).toBeUndefined()
    expect(getMeetingDurationMs({ transcript: [], mediaAssets: [asset({ durationMs: "x" })] })).toBeUndefined()
  })
})

describe("formatDurationLabel", () => {
  it("renders an em dash for unknown durations", () => {
    expect(formatDurationLabel(undefined)).toBe("—")
    expect(meetingDurationLabel({})).toBe("—")
  })

  it("formats short, minute and hour durations without inventing minimums", () => {
    expect(formatDurationLabel(20_000)).toBe("<1m")
    expect(formatDurationLabel(5 * 60_000)).toBe("5m")
    expect(formatDurationLabel(62 * 60_000)).toBe("1h 02m")
  })

  it("formats Hebrew labels", () => {
    expect(formatDurationLabel(45 * 60_000, "he")).toBe("45 דק׳")
    expect(formatDurationLabel(62 * 60_000, "he")).toBe("1 שע׳ 02 דק׳")
    expect(formatDurationLabel(20_000, "he")).toBe("פחות מדקה")
    expect(formatDurationLabel(undefined, "he")).toBe("—")
    expect(meetingDurationLabel({ durationMs: 45 * 60_000 }, "he-IL")).toBe("45 דק׳")
  })
})

describe("formatSpokenDuration", () => {
  it("speaks English durations", () => {
    expect(formatSpokenDuration(12 * 60_000 + 34_000, "en")).toBe("12 minutes 34 seconds")
    expect(formatSpokenDuration(3_600_000 + 60_000 + 1000)).toBe("1 hour 1 minute 1 second")
    expect(formatSpokenDuration(0)).toBe("0 seconds")
    expect(formatSpokenDuration(undefined)).toBe("—")
  })

  it("speaks Hebrew durations with vav-maqaf before the last part", () => {
    expect(formatSpokenDuration(12 * 60_000 + 34_000, "he")).toBe("12 דקות ו־34 שניות")
    expect(formatSpokenDuration(60_000, "he")).toBe("דקה אחת")
    expect(formatSpokenDuration(2 * 3_600_000 + 5_000, "he")).toBe("שעתיים ו־5 שניות")
    expect(formatSpokenDuration(3_600_000 + 2 * 60_000 + 1000, "he")).toBe(
      "שעה אחת, 2 דקות ו־שנייה אחת"
    )
    expect(formatSpokenDuration(400, "he")).toBe("0 שניות")
  })

  it("falls back to English for other locales without Intl.DurationFormat output", () => {
    expect(formatSpokenDuration(65_000, "xx-invalid-locale-$$")).toBe("1 minute 5 seconds")
  })
})

describe("formatTimestamp", () => {
  it("omits the hour below one hour", () => {
    expect(formatTimestamp(0)).toBe("0:00")
    expect(formatTimestamp(65_000)).toBe("1:05")
    expect(formatTimestamp(59 * 60_000 + 59_000)).toBe("59:59")
  })

  it("includes the hour from one hour", () => {
    expect(formatTimestamp(3_600_000)).toBe("1:00:00")
    expect(formatTimestamp(3_725_000)).toBe("1:02:05")
  })
})
