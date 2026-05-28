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

  it("throws when meeting is null", () => {
    expect(() => createRealizeOSPayload(null as unknown as MeetingRecord)).toThrow(
      "Meeting is required"
    )
  })
})
