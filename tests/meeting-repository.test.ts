import { describe, expect, it } from "vitest"

import {
  createInMemoryMeetingRepository,
  type CreateMeetingInput,
} from "@/lib/meetings/repository"

describe("meeting repository", () => {
  it("creates audio-first meetings with searchable summaries", () => {
    const repository = createInMemoryMeetingRepository()
    const input: CreateMeetingInput = {
      title: "Hebrew strategy review",
      source: "upload",
      language: "he",
      startedAt: "2026-04-23T09:00:00.000Z",
      participants: ["Ran", "Maya"],
    }

    const meeting = repository.createMeeting(input)

    expect(meeting).toMatchObject({
      title: "Hebrew strategy review",
      source: "upload",
      language: "he",
      status: "created",
      retention: "audio",
    })
    expect(repository.searchMeetings("strategy")).toHaveLength(1)
  })

  it("answers questions from transcript and summary context", () => {
    const repository = createInMemoryMeetingRepository([
      {
        id: "meet_1",
        title: "RealizeOS integration",
        source: "google_meet",
        language: "he",
        status: "completed",
        retention: "audio",
        startedAt: "2026-04-23T09:00:00.000Z",
        participants: ["Ran", "Codex"],
        summary: {
          overview: "RealizeOS should receive meeting context after summaries.",
          decisions: ["Send summaries through the outbound API first."],
          actionItems: [
            {
              id: "act_1",
              title: "Create RealizeOS webhook connector",
              owner: "Ran",
              status: "open",
            },
          ],
        },
        transcript: [
          {
            id: "seg_1",
            speaker: "Ran",
            startMs: 0,
            endMs: 4200,
            text: "We need RealizeOS to receive context from every meeting.",
          },
        ],
      },
    ])

    const answer = repository.askMeetingMemory(
      "meet_1",
      "What should RealizeOS receive?",
    )

    expect(answer.answer).toContain("meeting context")
    expect(answer.citations).toEqual([
      {
        meetingId: "meet_1",
        segmentId: "seg_1",
        startMs: 0,
      },
    ])
  })
})
