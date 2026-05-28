import { describe, expect, it } from "vitest"

import { suggestRooms } from "@/lib/rooms"
import type { MeetingRecord } from "@/lib/meetings/repository"

function fakeMeeting(overrides: Partial<MeetingRecord> & { id: string; title: string }): MeetingRecord {
  return {
    source: "google_meet",
    language: "en",
    status: "completed",
    retention: "audio",
    startedAt: new Date().toISOString(),
    participants: [],
    ...overrides,
  }
}

describe("suggestRooms", () => {
  it("suggests rooms from recurring title prefixes", () => {
    const meetings = [
      fakeMeeting({ id: "m1", title: "Weekly Standup - Week 1" }),
      fakeMeeting({ id: "m2", title: "Weekly Standup - Week 2" }),
      fakeMeeting({ id: "m3", title: "Weekly Standup - Week 3" }),
      fakeMeeting({ id: "m4", title: "Product Review: Sprint 10" }),
      fakeMeeting({ id: "m5", title: "Product Review: Sprint 11" }),
    ]

    const suggestions = suggestRooms(meetings, [])

    expect(suggestions.length).toBeGreaterThanOrEqual(2)

    const standupSuggestion = suggestions.find((s) => s.name === "Weekly Standup")
    expect(standupSuggestion).toBeTruthy()
    expect(standupSuggestion!.meetingCount).toBe(3)

    const productSuggestion = suggestions.find((s) => s.name === "Product Review")
    expect(productSuggestion).toBeTruthy()
    expect(productSuggestion!.meetingCount).toBe(2)
  })

  it("suggests rooms from common tags", () => {
    const meetings = [
      fakeMeeting({ id: "m1", title: "Sales call A", tags: ["sales" as const] }),
      fakeMeeting({ id: "m2", title: "Sales call B", tags: ["sales" as const] }),
      fakeMeeting({ id: "m3", title: "Sales call C", tags: ["sales" as const] }),
    ]

    const suggestions = suggestRooms(meetings, [])
    const salesSuggestion = suggestions.find((s) => s.name === "Sales")

    expect(salesSuggestion).toBeTruthy()
    expect(salesSuggestion!.meetingCount).toBe(3)
    expect(salesSuggestion!.reason).toContain("tagged")
  })

  it("skips already existing room names", () => {
    const meetings = [
      fakeMeeting({ id: "m1", title: "Weekly Standup - Week 1" }),
      fakeMeeting({ id: "m2", title: "Weekly Standup - Week 2" }),
    ]

    const suggestions = suggestRooms(meetings, ["Weekly Standup"])

    expect(suggestions.find((s) => s.name === "Weekly Standup")).toBeUndefined()
  })

  it("skips generic language tags", () => {
    const meetings = [
      fakeMeeting({ id: "m1", title: "Meeting A", tags: ["hebrew" as const] }),
      fakeMeeting({ id: "m2", title: "Meeting B", tags: ["hebrew" as const] }),
      fakeMeeting({ id: "m3", title: "Meeting C", tags: ["hebrew" as const] }),
    ]

    const suggestions = suggestRooms(meetings, [])

    expect(suggestions.find((s) => s.name.toLowerCase() === "hebrew")).toBeUndefined()
  })

  it("limits suggestions to 5", () => {
    const meetings: MeetingRecord[] = []

    for (let index = 0; index < 20; index++) {
      const group = `Group ${index % 7}`
      meetings.push(fakeMeeting({ id: `m${index}`, title: `${group} - Session ${index}` }))
    }

    const suggestions = suggestRooms(meetings, [])

    expect(suggestions.length).toBeLessThanOrEqual(5)
  })

  it("handles parenthetical title patterns", () => {
    const meetings = [
      fakeMeeting({ id: "m1", title: "PAT Sisters (Jan 15)" }),
      fakeMeeting({ id: "m2", title: "PAT Sisters (Feb 12)" }),
    ]

    const suggestions = suggestRooms(meetings, [])
    const patSuggestion = suggestions.find((s) => s.name === "PAT Sisters")

    expect(patSuggestion).toBeTruthy()
    expect(patSuggestion!.meetingCount).toBe(2)
  })

  it("returns empty for unrelated meetings", () => {
    const meetings = [
      fakeMeeting({ id: "m1", title: "A completely unique meeting" }),
      fakeMeeting({ id: "m2", title: "Another unique discussion" }),
    ]

    const suggestions = suggestRooms(meetings, [])

    expect(suggestions.length).toBe(0)
  })
})
