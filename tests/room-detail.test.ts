import { describe, it, expect } from "vitest"

import { buildRoomDetail } from "@/lib/rooms"
import type { MeetingContext, MeetingRecord } from "@/lib/meetings/repository"

const room: MeetingContext & { meetingCount: number } = {
  id: "ctx_1",
  name: "Product Standup",
  description: "Daily sync",
  kind: "project",
  createdAt: "2026-05-20T08:00:00Z",
  meetingCount: 3,
}

function makeMeeting(overrides: Partial<MeetingRecord>): MeetingRecord {
  return {
    id: "meet_1",
    title: "Standup #1",
    source: "google_meet",
    language: "he",
    status: "completed",
    retention: "audio",
    startedAt: "2026-05-27T09:00:00Z",
    participants: ["Asaf", "Ran"],
    isFavorite: false,
    participantDetails: [
      {
        id: "p_1",
        meetingId: "meet_1",
        name: "Asaf",
        email: "asaf@sufzen.com",
        role: "organizer",
        source: "calendar",
        attendanceStatus: "accepted",
        confidence: 1,
        createdAt: "2026-05-27T09:00:00Z",
        updatedAt: "2026-05-27T09:00:00Z",
      },
      {
        id: "p_2",
        meetingId: "meet_1",
        name: "Ran",
        role: "attendee",
        source: "calendar",
        attendanceStatus: "accepted",
        confidence: 1,
        createdAt: "2026-05-27T09:00:00Z",
        updatedAt: "2026-05-27T09:00:00Z",
      },
    ],
    summary: {
      overview: "Sprint review",
      decisions: [],
      actionItems: [
        { id: "ai_1", title: "Deploy v0.1.0", owner: "Asaf", status: "open" },
        { id: "ai_2", title: "Write docs", owner: "Ran", status: "done" },
      ],
    },
    ...overrides,
  }
}

describe("buildRoomDetail", () => {
  it("computes stats from meetings", () => {
    const meetings = [
      makeMeeting({ id: "m1", status: "completed" }),
      makeMeeting({ id: "m2", status: "transcribing" }),
      makeMeeting({ id: "m3", status: "failed" }),
    ]
    const detail = buildRoomDetail(room, meetings)

    expect(detail.room.id).toBe("ctx_1")
    expect(detail.stats.meetings).toBe(3)
    expect(detail.stats.completedMeetings).toBe(1)
    expect(detail.stats.processingMeetings).toBe(1)
    expect(detail.stats.openTasks).toBe(3) // 1 per meeting
  })

  it("collects open tasks across all meetings", () => {
    const meetings = [
      makeMeeting({ id: "m1" }),
      makeMeeting({ id: "m2" }),
    ]
    const detail = buildRoomDetail(room, meetings)

    expect(detail.openTasks).toHaveLength(2)
    expect(detail.openTasks[0].title).toBe("Deploy v0.1.0")
    expect(detail.openTasks[0].meetingId).toBe("m1")
  })

  it("deduplicates participants by email", () => {
    const meetings = [
      makeMeeting({ id: "m1" }),
      makeMeeting({ id: "m2" }),
    ]
    const detail = buildRoomDetail(room, meetings)

    const asaf = detail.participants.find((p) => p.name === "Asaf")
    expect(asaf?.meetingCount).toBe(2)
    expect(asaf?.email).toBe("asaf@sufzen.com")
  })

  it("sorts participants by meeting count descending", () => {
    const meetings = [
      makeMeeting({ id: "m1" }),
      makeMeeting({ id: "m2" }),
    ]
    const detail = buildRoomDetail(room, meetings)

    // Both have 2 meetings each, so order should be stable
    expect(detail.participants.length).toBeGreaterThan(0)
    for (let i = 1; i < detail.participants.length; i++) {
      expect(detail.participants[i - 1].meetingCount).toBeGreaterThanOrEqual(
        detail.participants[i].meetingCount
      )
    }
  })

  it("handles empty meeting list", () => {
    const detail = buildRoomDetail(room, [])

    expect(detail.stats.meetings).toBe(0)
    expect(detail.openTasks).toHaveLength(0)
    expect(detail.participants).toHaveLength(0)
  })
})
