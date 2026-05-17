import { describe, expect, it } from "vitest"

import { buildMeetingMemoryAnswer, buildMeetingMemoryResults } from "@/lib/memory"
import type { MeetingRecord } from "@/lib/meetings/repository"

function meeting(overrides: Partial<MeetingRecord>): MeetingRecord {
  return {
    id: "meeting_1",
    title: "RealizeOS planning",
    source: "google_meet",
    language: "mixed",
    status: "completed",
    retention: "audio",
    startedAt: "2026-05-07T10:00:00.000Z",
    participants: [],
    summary: {
      overview:
        "The team decided that RealizeOS export should run after meeting summaries are approved.",
      decisions: ["Keep RealizeOS export behind manual approval."],
      actionItems: [
        {
          id: "task_1",
          title: "Ran will test the RealizeOS export payload",
          status: "open",
          owner: "Ran",
        },
      ],
    },
    transcript: [
      {
        id: "seg_1",
        speaker: "Ran",
        startMs: 12000,
        endMs: 18000,
        text: "We should only send RealizeOS after the summary looks correct.",
      },
    ],
    tags: ["operations", "technical"],
    ...overrides,
  }
}

describe("meeting memory", () => {
  it("returns cited search results across summary, tasks, tags, and transcript", () => {
    const results = buildMeetingMemoryResults(
      [meeting({}), meeting({ id: "meeting_2", title: "Unrelated" })],
      "RealizeOS export operations",
      { limit: 5 }
    )

    expect(results[0]).toMatchObject({
      id: "meeting_1",
      title: "RealizeOS planning",
      matchCount: 5,
    })
    expect(results[0].matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "summary" }),
        expect.objectContaining({ source: "decision" }),
        expect.objectContaining({ source: "action_item" }),
        expect.objectContaining({ source: "transcript", startMs: 12000 }),
      ])
    )
  })

  it("builds an answer with explicit citations", () => {
    const answer = buildMeetingMemoryAnswer("What did we decide about RealizeOS?", [
      meeting({}),
    ])

    expect(answer.answer).toContain("RealizeOS planning")
    expect(answer.citations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          meetingId: "meeting_1",
          meetingTitle: "RealizeOS planning",
          source: "decision",
        }),
        expect.objectContaining({
          meetingId: "meeting_1",
          source: "transcript",
          segmentId: "seg_1",
          startMs: 12000,
        }),
      ])
    )
  })
})
