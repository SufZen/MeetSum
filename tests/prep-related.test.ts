import { describe, expect, it } from "vitest"

import { testMeeting } from "./helpers/route-ctx"

import {
  findRelatedMeetings,
  jaccard,
  scoreRelatedMeetings,
  titleTokens,
} from "@/lib/intelligence/prep/related"
import {
  createInMemoryMeetingRepository,
  type MeetingParticipant,
  type MeetingRecord,
} from "@/lib/meetings/repository"

function person(meetingId: string, email: string, name = email.split("@")[0]): MeetingParticipant {
  return {
    id: `p_${meetingId}_${email}`,
    meetingId,
    name,
    email,
    role: "attendee",
    source: "calendar",
    attendanceStatus: "accepted",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }
}

const room = { id: "ctx_lisboa", name: "Lisboa Riverside", kind: "room" as const, createdAt: "2026-01-01T00:00:00.000Z" }

function meeting(id: string, overrides: Partial<MeetingRecord> = {}): MeetingRecord {
  return testMeeting({ id, workspaceId: "ws_a", startedAt: "2026-10-01T10:00:00.000Z", ...overrides })
}

const target = meeting("m_target", {
  title: "עדכון עסקה — Lisboa Riverside",
  status: "scheduled",
  startedAt: "2026-10-20T10:00:00.000Z",
  participantDetails: [person("m_target", "dana@x.co"), person("m_target", "avi@x.co")],
  contexts: [room],
})

describe("scoreRelatedMeetings", () => {
  const now = new Date("2026-10-13T00:00:00.000Z")

  it("weights participants 0.5, room 0.3 and title 0.2", () => {
    const candidates = [
      meeting("m_same_people", {
        title: "Budget review",
        participantDetails: [person("m_same_people", "dana@x.co"), person("m_same_people", "avi@x.co")],
      }),
      meeting("m_same_room", { title: "Kickoff", contexts: [room] }),
      meeting("m_same_title", { title: "Lisboa Riverside עדכון" }),
      meeting("m_unrelated", { title: "Hiring sync" }),
    ]
    const related = scoreRelatedMeetings(target, candidates, { now })

    expect(related.map((item) => [item.meetingId, item.score])).toEqual([
      ["m_same_people", 0.5],
      ["m_same_room", 0.3],
      ["m_same_title", expect.closeTo(0.2 * (3 / 4), 3)],
    ])
    expect(related[0].signals).toEqual({ participants: 1, room: 0, title: 0 })
  })

  it("excludes itself, non-completed, future and older-than-180-days meetings, and caps at 5", () => {
    const candidates = [
      { ...target },
      meeting("m_failed", { status: "failed", contexts: [room] }),
      meeting("m_future", { startedAt: "2026-11-01T10:00:00.000Z", contexts: [room] }),
      meeting("m_old", { startedAt: "2026-03-01T10:00:00.000Z", contexts: [room] }),
      ...Array.from({ length: 7 }, (_, index) =>
        meeting(`m_room_${index}`, { contexts: [room], startedAt: `2026-09-0${index + 1}T10:00:00.000Z` })
      ),
    ]
    const related = scoreRelatedMeetings(target, candidates, { now })

    expect(related).toHaveLength(5)
    expect(related.map((item) => item.meetingId)).toEqual([
      "m_room_6",
      "m_room_5",
      "m_room_4",
      "m_room_3",
      "m_room_2",
    ])
  })

  it("tokenizes titles without stopwords or numbers and computes Jaccard", () => {
    expect([...titleTokens("פגישה שבועית עם Dana — Q4 2026")]).toEqual(["dana", "q4"])
    expect(jaccard(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(1 / 3)
    expect(jaccard(new Set(), new Set(["a"]))).toBe(0)
  })
})

describe("findRelatedMeetings", () => {
  it("only scores meetings the scope can see", async () => {
    const repo = createInMemoryMeetingRepository(
      [
        target,
        meeting("m_visible", { contexts: [room] }),
        meeting("m_private", { contexts: [room], visibility: "private", ownerUserId: "someone_else" }),
        meeting("m_other_ws", { contexts: [room], workspaceId: "ws_b" }),
      ],
      { kind: "member", workspaceId: "ws_a", userId: "user_me", email: "me@x.co", role: "member" }
    )

    const related = await findRelatedMeetings(repo, target, { now: new Date("2026-10-13T00:00:00.000Z") })

    expect(related.map((item) => item.meetingId)).toEqual(["m_visible"])
  })
})
