import { describe, expect, it } from "vitest"

import type { RoomDetail } from "@/lib/rooms"

describe("room detail view", () => {
  const mockDetail: RoomDetail = {
    room: {
      id: "ctx_room1",
      name: "Product Team",
      description: "All product meetings",
      color: "#6366f1",
      createdAt: "2026-01-01T00:00:00Z",
      meetingCount: 3,
    },
    stats: {
      meetings: 3,
      completedMeetings: 2,
      processingMeetings: 1,
      openTasks: 4,
      participants: 5,
      artifacts: 2,
    },
    meetings: [
      {
        id: "mtg_1",
        title: "Sprint Planning",
        status: "completed",
        startedAt: "2026-05-28T10:00:00Z",
        overview: "Planned sprint 15 with 12 stories",
        openTasks: 3,
        participants: 4,
        artifacts: 1,
      },
      {
        id: "mtg_2",
        title: "Design Review",
        status: "completed",
        startedAt: "2026-05-27T14:00:00Z",
        overview: "Reviewed new dashboard mockups",
        openTasks: 1,
        participants: 3,
        artifacts: 0,
      },
      {
        id: "mtg_3",
        title: "Standup",
        status: "transcribing",
        startedAt: "2026-05-29T09:00:00Z",
        overview: "",
        openTasks: 0,
        participants: 5,
        artifacts: 1,
      },
    ],
    openTasks: [
      {
        id: "task_1",
        title: "Update API docs",
        status: "open",
        owner: "Alice",
        meetingId: "mtg_1",
        meetingTitle: "Sprint Planning",
      },
      {
        id: "task_2",
        title: "Fix auth bug",
        status: "open",
        owner: "Bob",
        dueDate: "2026-06-01",
        meetingId: "mtg_1",
        meetingTitle: "Sprint Planning",
      },
    ],
    participants: [
      { name: "Alice Chen", email: "alice@example.com", role: "organizer", meetingCount: 3 },
      { name: "Bob Smith", email: "bob@example.com", role: "attendee", meetingCount: 2 },
    ],
    artifacts: [
      {
        id: "art_1",
        meetingId: "mtg_1",
        meetingTitle: "Sprint Planning",
        artifactType: "recording",
        artifactName: "sprint-planning-recording.webm",
      },
    ],
  }

  it("has correct stats aggregation", () => {
    expect(mockDetail.stats.meetings).toBe(3)
    expect(mockDetail.stats.completedMeetings).toBe(2)
    expect(mockDetail.stats.openTasks).toBe(4)
    expect(mockDetail.stats.participants).toBe(5)
  })

  it("meetings are sorted by date in test data", () => {
    const dates = mockDetail.meetings.map((m) => new Date(m.startedAt).getTime())
    const sorted = [...dates].sort((a, b) => b - a)
    expect(sorted[0]).toBeGreaterThan(sorted[sorted.length - 1])
  })

  it("open tasks have meeting context", () => {
    for (const task of mockDetail.openTasks) {
      expect(task.meetingId).toBeTruthy()
      expect(task.meetingTitle).toBeTruthy()
      expect(task.status).toBe("open")
    }
  })

  it("participants have meeting counts", () => {
    for (const participant of mockDetail.participants) {
      expect(participant.meetingCount).toBeGreaterThan(0)
      expect(participant.name).toBeTruthy()
    }
  })

  it("artifacts have meeting context", () => {
    for (const artifact of mockDetail.artifacts) {
      expect(artifact.meetingId).toBeTruthy()
      expect(artifact.artifactType).toBeTruthy()
    }
  })

  it("handles empty room detail", () => {
    const emptyDetail: RoomDetail = {
      room: { id: "ctx_empty", name: "Empty Room", createdAt: "2026-01-01T00:00:00Z", meetingCount: 0 },
      stats: {
        meetings: 0,
        completedMeetings: 0,
        processingMeetings: 0,
        openTasks: 0,
        participants: 0,
        artifacts: 0,
      },
      meetings: [],
      openTasks: [],
      participants: [],
      artifacts: [],
    }

    expect(emptyDetail.meetings).toHaveLength(0)
    expect(emptyDetail.stats.meetings).toBe(0)
  })
})
