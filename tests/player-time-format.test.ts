import { describe, expect, it } from "vitest"

import {
  formatClock,
  formatDurationShort,
  formatSpokenTime,
  meetingDurationMs,
} from "@/lib/player/time-format"

describe("formatClock", () => {
  it("formats m:ss and h:mm:ss", () => {
    expect(formatClock(0)).toBe("0:00")
    expect(formatClock(754_900)).toBe("12:34")
    expect(formatClock(3_725_000)).toBe("1:02:05")
    expect(formatClock(-5)).toBe("0:00")
    expect(formatClock(Number.NaN)).toBe("0:00")
  })
})

describe("formatSpokenTime", () => {
  it("speaks Hebrew with vav + maqaf before the last part", () => {
    expect(formatSpokenTime(754_000, "he")).toBe("12 דקות ו־34 שניות")
    expect(formatSpokenTime(3_661_000, "he")).toBe("1 שעה, 1 דקה ו־1 שנייה")
    expect(formatSpokenTime(120_000, "he")).toBe("2 דקות")
    expect(formatSpokenTime(0, "he")).toBe("0 שניות")
  })

  it("speaks English", () => {
    expect(formatSpokenTime(754_000, "en")).toBe("12 minutes 34 seconds")
    expect(formatSpokenTime(3_601_000, "en")).toBe("1 hour 1 second")
    expect(formatSpokenTime(0, "en")).toBe("0 seconds")
  })
})

describe("durations", () => {
  it("prefers the denormalized meeting duration", () => {
    expect(meetingDurationMs({ durationMs: 90_000, transcript: [] })).toBe(90_000)
    expect(
      meetingDurationMs({
        transcript: [{ id: "s", speaker: "A", startMs: 0, endMs: 61_000, text: "x" }],
      })
    ).toBe(61_000)
    expect(meetingDurationMs({})).toBeUndefined()
  })

  it("formats compact labels per locale and never invents a number", () => {
    expect(formatDurationShort(45 * 60_000, "en")).toBe("45m")
    expect(formatDurationShort(62 * 60_000, "en")).toBe("1h 02m")
    expect(formatDurationShort(45 * 60_000, "he")).toBe("45 דק׳")
    expect(formatDurationShort(62 * 60_000, "he")).toBe("1 שע׳ 02 דק׳")
    expect(formatDurationShort(undefined, "he")).toBe("—")
    expect(formatDurationShort(0, "en")).toBe("—")
  })
})
