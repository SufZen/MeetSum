import { describe, it, expect } from "vitest"

import { createRealizeOSPayload } from "@/lib/integrations/realizeos"
import type { MeetingRecord } from "@/lib/meetings/repository"

function makeMeeting(overrides: Partial<MeetingRecord> = {}): MeetingRecord {
  return {
    id: "meet_ros",
    title: "RealizeOS integration review",
    source: "google_meet",
    language: "en",
    status: "completed",
    retention: "audio",
    startedAt: "2026-05-27T10:00:00Z",
    participants: ["Asaf", "Ran"],
    isFavorite: false,
    summary: {
      overview: "Discussed RealizeOS MCP routing fixes.",
      decisions: ["Proceed with Option B"],
      actionItems: [
        {
          id: "ai_1",
          title: "Fix API prefix middleware",
          owner: "Asaf",
          status: "open",
        },
      ],
    },
    transcript: [
      {
        id: "seg_1",
        speaker: "Asaf",
        startMs: 0,
        endMs: 5000,
        text: "Let's review the integration",
        confidence: 0.9,
        language: "en",
      },
      {
        id: "seg_2",
        speaker: "Ran",
        startMs: 5000,
        endMs: 10000,
        text: "Sounds good, Option B looks best",
        confidence: 0.85,
        language: "en",
      },
    ],
    aiRuns: [
      {
        id: "run_1",
        meetingId: "meet_ros",
        provider: "gemini",
        task: "audio.transcribe",
        model: "gemini-3.5-flash",
        status: "completed",
        latencyMs: 3200,
        confidence: 0.9,
        metadata: {},
        startedAt: "2026-05-27T10:01:00Z",
        completedAt: "2026-05-27T10:01:03Z",
      },
    ],
    ...overrides,
  }
}

describe("createRealizeOSPayload", () => {
  it("includes meeting metadata, summary, and transcript citations", () => {
    const payload = createRealizeOSPayload(makeMeeting())

    expect(payload.source).toBe("meetsum")
    expect(payload.exportedAt).toBeTruthy()
    expect(payload.meeting.id).toBe("meet_ros")
    expect(payload.meeting.title).toBe("RealizeOS integration review")
    expect(payload.meeting.source).toBe("google_meet")
    expect(payload.meeting.participants).toEqual(["Asaf", "Ran"])
    expect(payload.summary?.overview).toBe("Discussed RealizeOS MCP routing fixes.")
    expect(payload.actionItems).toHaveLength(1)
    expect(payload.actionItems[0].title).toBe("Fix API prefix middleware")
    expect(payload.transcript.segmentCount).toBe(2)
    expect(payload.transcript.citations).toHaveLength(2)
    expect(payload.transcript.citations[0].speaker).toBe("Asaf")
  })

  it("includes AI run processing metadata", () => {
    const payload = createRealizeOSPayload(makeMeeting())

    expect(payload.processing.aiRuns).toHaveLength(1)
    expect(payload.processing.aiRuns[0].provider).toBe("gemini")
    expect(payload.processing.aiRuns[0].model).toBe("gemini-3.5-flash")
    expect(payload.processing.aiRuns[0].latencyMs).toBe(3200)
  })

  it("limits transcript citations to 20", () => {
    const manySegments = Array.from({ length: 50 }, (_, i) => ({
      id: `seg_${i}`,
      speaker: "Speaker 1",
      startMs: i * 5000,
      endMs: (i + 1) * 5000,
      text: `Segment ${i}`,
      confidence: 0.8,
      language: "en",
    }))
    const payload = createRealizeOSPayload(makeMeeting({ transcript: manySegments }))

    expect(payload.transcript.segmentCount).toBe(50)
    expect(payload.transcript.citations).toHaveLength(20)
  })

  it("handles meetings without optional fields", () => {
    const payload = createRealizeOSPayload(
      makeMeeting({
        summary: undefined,
        transcript: undefined,
        aiRuns: undefined,
        contexts: undefined,
        meetConferenceRecords: undefined,
      })
    )

    expect(payload.summary).toBeUndefined()
    expect(payload.actionItems).toEqual([])
    expect(payload.transcript.segmentCount).toBe(0)
    expect(payload.processing.aiRuns).toEqual([])
    expect(payload.contexts).toEqual([])
  })

  it("pins the v2 outbound shape: schemaVersion and English text for quality warnings", () => {
    const payload = createRealizeOSPayload(
      makeMeeting({
        qualityWarnings: [
          { code: "transcription_fallback", severity: "warning", params: { provider: "gemini" } },
          { code: "task_missing_owner_or_due_date", severity: "info", params: { count: 2 } },
          { code: "smart_notes_only", severity: "info" },
        ],
      })
    )

    expect(payload.schemaVersion).toBe(2)
    expect(payload.processing.qualityWarnings).toEqual([
      {
        code: "transcription_fallback",
        severity: "warning",
        params: { provider: "gemini" },
        title: "Transcription fallback used",
        message: "The primary transcription path failed, so MeetSum used gemini.",
      },
      {
        code: "task_missing_owner_or_due_date",
        severity: "info",
        params: { count: 2 },
        title: "Tasks need an owner or due date",
        message: "2 open action items need an owner or due date before external automation.",
      },
      {
        code: "smart_notes_only",
        severity: "info",
        title: "Smart notes source",
        message: "This meeting was generated from Google smart notes, not a full transcript or audio recording.",
      },
    ])
  })

  it("pins the v2 outbound shape of suggested runs: intent code plus English title/description", () => {
    const payload = createRealizeOSPayload(
      makeMeeting({
        suggestedAgentRuns: [
          {
            id: "sug_1",
            meetingId: "meet_ros",
            target: "realizeos",
            status: "suggested",
            payload: { intent: "export_to_realizeos", meetingId: "meet_ros" },
            createdAt: "2026-05-27T10:05:00Z",
          },
          {
            id: "sug_2",
            meetingId: "meet_ros",
            target: "webhook",
            status: "sent",
            payload: { intent: "custom_intent" },
            createdAt: "2026-05-27T10:05:00Z",
          },
        ],
      })
    )

    expect(payload.suggestedRuns).toEqual([
      {
        id: "sug_1",
        target: "realizeos",
        status: "suggested",
        intent: "export_to_realizeos",
        title: "Export to RealizeOS",
        description: "Send structured meeting context into RealizeOS memory.",
      },
      { id: "sug_2", target: "webhook", status: "sent", intent: "custom_intent", title: "custom_intent", description: "" },
    ])
  })

  it("throws when meeting is null", () => {
    expect(() => createRealizeOSPayload(null as unknown as MeetingRecord)).toThrow(
      "Meeting is required"
    )
  })
})
