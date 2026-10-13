import { describe, expect, it } from "vitest"

import { participantRowId } from "@/lib/meetings/postgres-repository"

describe("participantRowId", () => {
  it("gives each participant of a long-id meeting a distinct, stable id", () => {
    const meetingId = "meet_google_calendar_0123456789abcdef0123456789abcdef"
    const ids = ["רונית", "Avi", "dana@meetsum.test"].map((name) =>
      participantRowId(meetingId, name)
    )

    expect(new Set(ids).size).toBe(3)
    expect(participantRowId(meetingId, "Avi")).toBe(ids[1])
  })
})
