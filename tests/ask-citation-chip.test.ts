import { describe, expect, it, vi } from "vitest"

import { citationAction } from "@/components/ask/citation-action"

const resolved = { segmentIndex: 3, segmentId: "seg-4", startMs: 61_000 }

describe("citationAction", () => {
  it("seeks the player for a citation in the open meeting", () => {
    const resolve = vi.fn(() => resolved)

    expect(
      citationAction(
        { meetingId: "m1", segmentId: "seg-4", startMs: 61_000 },
        { locale: "he", currentMeetingId: "m1", playerAvailable: true, resolve }
      )
    ).toEqual({ kind: "seek", startMs: 61_000, segmentId: "seg-4" })
    expect(resolve).toHaveBeenCalledWith({ segmentId: "seg-4", startMs: 61_000 })
  })

  it("navigates to the deep link for another meeting", () => {
    const resolve = vi.fn(() => resolved)

    expect(
      citationAction(
        { meetingId: "m 2", segmentId: "seg-9", startMs: 125_900 },
        { locale: "en", currentMeetingId: "m1", playerAvailable: true, resolve }
      )
    ).toEqual({ kind: "navigate", href: "/en?meeting=m+2&t=125" })
    expect(resolve).not.toHaveBeenCalled()
  })

  it("navigates when there is no player (global and room Ask)", () => {
    expect(
      citationAction(
        { meetingId: "m1", startMs: 5_000 },
        { locale: "he", playerAvailable: false, resolve: () => undefined }
      )
    ).toEqual({ kind: "navigate", href: "/he?meeting=m1&t=5" })
  })

  it("is not rendered when the same-meeting citation doesn't resolve", () => {
    expect(
      citationAction(
        { meetingId: "m1", segmentId: "gone", startMs: 9_999_000 },
        { locale: "he", currentMeetingId: "m1", playerAvailable: true, resolve: () => undefined }
      )
    ).toEqual({ kind: "hidden" })
  })

  it("is not rendered without a meeting, or without a time or segment", () => {
    const context = { locale: "he", playerAvailable: false, resolve: () => undefined }

    expect(citationAction({ meetingId: "", startMs: 1000 }, context)).toEqual({ kind: "hidden" })
    expect(citationAction({ meetingId: "m1" }, context)).toEqual({ kind: "hidden" })
    expect(citationAction({ meetingId: "m1", startMs: Number.NaN }, context)).toEqual({ kind: "hidden" })
  })

  it("opens at the start for a segment-only citation in another meeting", () => {
    expect(
      citationAction({ meetingId: "m2", segmentId: "s" }, { locale: "he", playerAvailable: false, resolve: () => undefined })
    ).toEqual({ kind: "navigate", href: "/he?meeting=m2&t=0" })
  })

  it("is disabled when the meeting is no longer visible", () => {
    expect(
      citationAction(
        { meetingId: "m1", startMs: 1000, unavailable: true },
        { locale: "he", currentMeetingId: "m1", playerAvailable: true, resolve: () => resolved }
      )
    ).toEqual({ kind: "disabled" })
  })
})
