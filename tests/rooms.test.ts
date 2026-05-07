import { describe, expect, it } from "vitest"

import { buildRoomDetail } from "@/lib/rooms"
import type { MeetingContext, MeetingRecord } from "@/lib/meetings/repository"

const room: MeetingContext & { meetingCount: number } = {
  id: "room_1",
  name: "Real Estate Acquisitions",
  description: "Acquisition meetings and diligence work",
  kind: "room",
  createdAt: "2026-05-07T10:00:00.000Z",
  meetingCount: 2,
}

function meeting(overrides: Partial<MeetingRecord>): MeetingRecord {
  return {
    id: "meeting_1",
    title: "Lisbon acquisition review",
    source: "google_meet",
    language: "mixed",
    status: "completed",
    retention: "audio",
    startedAt: "2026-05-07T10:00:00.000Z",
    participants: ["ran@example.com"],
    participantDetails: [
      {
        id: "participant_1",
        meetingId: "meeting_1",
        name: "Ran",
        email: "ran@example.com",
        role: "organizer",
        source: "calendar",
        attendanceStatus: "accepted",
        createdAt: "2026-05-07T10:00:00.000Z",
        updatedAt: "2026-05-07T10:00:00.000Z",
      },
    ],
    summary: {
      overview: "The team reviewed acquisition diligence.",
      decisions: ["Proceed with legal review."],
      actionItems: [
        {
          id: "task_1",
          title: "Send diligence pack",
          owner: "Ran",
          status: "open",
          priority: "high",
        },
      ],
    },
    meetConferenceRecords: [
      {
        id: "conf_1",
        conferenceRecordName: "conferenceRecords/abc",
        artifacts: [
          {
            id: "artifact_1",
            conferenceRecordId: "conf_1",
            conferenceRecordName: "conferenceRecords/abc",
            artifactType: "recording",
            artifactName: "conferenceRecords/abc/recordings/rec",
          },
        ],
      },
    ],
    ...overrides,
  }
}

describe("room detail", () => {
  it("summarizes meetings, open tasks, participants, and artifacts", () => {
    const detail = buildRoomDetail(room, [
      meeting({}),
      meeting({
        id: "meeting_2",
        title: "Porto follow-up",
        status: "summarizing",
        summary: {
          overview: "Follow-up discussion.",
          decisions: [],
          actionItems: [
            {
              id: "task_2",
              title: "Completed task",
              status: "done",
            },
          ],
        },
      }),
    ])

    expect(detail.stats).toEqual({
      meetings: 2,
      completedMeetings: 1,
      processingMeetings: 1,
      openTasks: 1,
      participants: 1,
      artifacts: 2,
    })
    expect(detail.openTasks).toEqual([
      expect.objectContaining({
        id: "task_1",
        meetingId: "meeting_1",
        meetingTitle: "Lisbon acquisition review",
      }),
    ])
    expect(detail.participants).toEqual([
      expect.objectContaining({ name: "Ran", meetingCount: 2 }),
    ])
  })
})
