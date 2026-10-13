import { describe, expect, it } from "vitest"

import * as duration from "@/lib/meetings/duration"
import {
  formatClock,
  formatDurationLabel,
  formatSpokenDuration,
  getMeetingDurationMs,
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

describe("duration helpers come from lib/meetings/duration", () => {
  it("re-exports Package B's implementations (no stand-ins)", () => {
    expect(formatClock).toBe(duration.formatTimestamp)
    expect(formatDurationLabel).toBe(duration.formatDurationLabel)
    expect(formatSpokenDuration).toBe(duration.formatSpokenDuration)
    expect(getMeetingDurationMs).toBe(duration.getMeetingDurationMs)
  })

  it("speaks and labels durations per locale", () => {
    expect(formatSpokenDuration(754_000, "he")).toBe("12 דקות ו־34 שניות")
    expect(formatSpokenDuration(754_000, "en")).toBe("12 minutes 34 seconds")
    expect(formatDurationLabel(62 * 60_000, "he")).toBe("1 שע׳ 02 דק׳")
    expect(formatDurationLabel(undefined, "en")).toBe("—")
    expect(getMeetingDurationMs({ durationMs: 90_000, transcript: [] })).toBe(90_000)
  })
})
