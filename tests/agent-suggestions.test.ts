import { describe, expect, it } from "vitest"

import { buildMeetingAgentSuggestions } from "@/lib/agents/suggestions"
import type { MeetingRecord } from "@/lib/meetings/repository"

function meeting(overrides: Partial<MeetingRecord> = {}): MeetingRecord {
  return {
    id: "meeting_1",
    title: "Lisbon acquisition review",
    source: "google_meet",
    language: "mixed",
    status: "completed",
    retention: "audio",
    startedAt: "2026-05-07T10:00:00.000Z",
    participants: ["Ran", "Asaf"],
    participantDetails: [
      {
        id: "participant_1",
        meetingId: "meeting_1",
        name: "Ran Nahmany",
        email: "ran@example.com",
        role: "organizer",
        source: "calendar",
        attendanceStatus: "accepted",
        createdAt: "2026-05-07T10:00:00.000Z",
        updatedAt: "2026-05-07T10:00:00.000Z",
      },
    ],
    tags: ["real-estate", "follow-up-needed"],
    summary: {
      overview: "The team reviewed acquisition diligence and lender follow-up.",
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
    transcript: [
      {
        id: "seg_1",
        speaker: "Ran",
        startMs: 12000,
        endMs: 18000,
        text: "We should send the diligence pack today.",
      },
    ],
    ...overrides,
  }
}

describe("meeting agent suggestions", () => {
  it("suggests approval-based agents from processed meeting intelligence", () => {
    const suggestions = buildMeetingAgentSuggestions(meeting())

    expect(suggestions.map((suggestion) => suggestion.payload.intent)).toEqual([
      "export_to_realizeos",
      "draft_followup_email",
      "create_n8n_payload",
      "draft_client_recap",
      "extract_crm_notes",
    ])
    expect(suggestions.every((suggestion) => suggestion.payload.requiresApproval)).toBe(true)
    expect(suggestions[0]).toMatchObject({
      target: "realizeos",
      payload: {
        title: "Export to RealizeOS",
        meetingId: "meeting_1",
        meetingTitle: "Lisbon acquisition review",
        actionItemCount: 1,
        participantNames: ["Ran Nahmany"],
      },
    })
  })

  it("does not duplicate active suggestions for the same intent and target", () => {
    const suggestions = buildMeetingAgentSuggestions(
      meeting({
        suggestedAgentRuns: [
          {
            id: "agent_suggestion_1",
            meetingId: "meeting_1",
            target: "realizeos",
            payload: { intent: "export_to_realizeos" },
            status: "suggested",
            createdAt: "2026-05-07T10:00:00.000Z",
          },
          {
            id: "agent_suggestion_2",
            meetingId: "meeting_1",
            target: "mcp",
            payload: { intent: "draft_followup_email" },
            status: "failed",
            createdAt: "2026-05-07T10:00:00.000Z",
          },
        ],
      })
    )

    expect(suggestions.map((suggestion) => suggestion.payload.intent)).not.toContain(
      "export_to_realizeos"
    )
    expect(suggestions.map((suggestion) => suggestion.payload.intent)).toContain(
      "draft_followup_email"
    )
  })

  it("does not suggest external agents when the meeting has no processed content", () => {
    const suggestions = buildMeetingAgentSuggestions(
      meeting({
        status: "scheduled",
        summary: undefined,
        transcript: undefined,
      })
    )

    expect(suggestions).toEqual([])
  })
})
