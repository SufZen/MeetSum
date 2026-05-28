import { describe, it, expect } from "vitest"

import { renderMeetingMarkdown } from "@/lib/meetings/export"
import type { MeetingRecord } from "@/lib/meetings/repository"

function makeMeeting(overrides: Partial<MeetingRecord> = {}): MeetingRecord {
  return {
    id: "meet_test",
    title: "Weekly standup",
    source: "google_meet",
    language: "he",
    status: "completed",
    retention: "audio",
    startedAt: "2026-05-27T09:00:00Z",
    participants: ["Alice", "Bob"],
    isFavorite: false,
    summary: {
      overview: "Team discussed Q3 priorities.",
      decisions: ["Focus on MeetSum v0.1.0"],
      actionItems: [
        {
          id: "ai_1",
          title: "Create deployment pipeline",
          owner: "Asaf",
          status: "open",
          dueDate: "2026-06-01",
        },
      ],
    },
    transcript: [
      {
        id: "seg_1",
        speaker: "Alice",
        startMs: 0,
        endMs: 5000,
        text: "Let's discuss Q3 priorities.",
      },
    ],
    ...overrides,
  }
}

describe("renderMeetingMarkdown", () => {
  it("includes basic meeting info, summary, and transcript", () => {
    const md = renderMeetingMarkdown(makeMeeting())

    expect(md).toContain("# Weekly standup")
    expect(md).toContain("Source: google_meet")
    expect(md).toContain("Language: he")
    expect(md).toContain("## Overview")
    expect(md).toContain("Team discussed Q3 priorities.")
    expect(md).toContain("## Decisions")
    expect(md).toContain("Focus on MeetSum v0.1.0")
    expect(md).toContain("## Action Items")
    expect(md).toContain("[ ] Create deployment pipeline (Asaf)")
    expect(md).toContain("## Transcript")
    expect(md).toContain("00:00 Alice: Let's discuss Q3 priorities.")
  })

  it("includes provider metadata table when aiRuns are present", () => {
    const md = renderMeetingMarkdown(
      makeMeeting({
        aiRuns: [
          {
            id: "run_1",
            meetingId: "meet_test",
            provider: "gemini",
            task: "audio.transcribe",
            model: "gemini-3.5-flash",
            status: "completed",
            latencyMs: 4200,
            confidence: 0.92,
            metadata: {},
            startedAt: "2026-05-27T09:05:00Z",
            completedAt: "2026-05-27T09:05:04Z",
          },
          {
            id: "run_2",
            meetingId: "meet_test",
            provider: "gemini",
            task: "summary.generate",
            model: "gemini-3.5-flash",
            status: "completed",
            latencyMs: 1800,
            confidence: 0.85,
            metadata: {},
            startedAt: "2026-05-27T09:05:05Z",
            completedAt: "2026-05-27T09:05:07Z",
          },
        ],
      })
    )

    expect(md).toContain("## Processing Metadata")
    expect(md).toContain("| Transcription | gemini | gemini-3.5-flash | 4.2s | 92% |")
    expect(md).toContain("| Summary generation | gemini | gemini-3.5-flash | 1.8s | 85% |")
    expect(md).toContain("Processed by MeetSum")
  })

  it("includes transcription provider inline with model", () => {
    const md = renderMeetingMarkdown(
      makeMeeting({
        aiRuns: [
          {
            id: "run_1",
            meetingId: "meet_test",
            provider: "local-whisper",
            task: "audio.transcribe",
            model: "large-v3-turbo",
            status: "completed",
            latencyMs: 12000,
            metadata: {},
            startedAt: "2026-05-27T09:05:00Z",
          },
        ],
      })
    )

    expect(md).toContain(
      "> Transcription provided by **local-whisper** (model: large-v3-turbo)"
    )
  })

  it("does not include metadata section when no aiRuns", () => {
    const md = renderMeetingMarkdown(makeMeeting())

    expect(md).not.toContain("## Processing Metadata")
  })

  it("handles fallback provider metadata", () => {
    const md = renderMeetingMarkdown(
      makeMeeting({
        aiRuns: [
          {
            id: "run_1",
            meetingId: "meet_test",
            provider: "gemini",
            task: "audio.transcribe",
            model: "gemini-3.5-flash",
            status: "completed",
            latencyMs: 5000,
            metadata: {
              fallbackUsed: true,
              attemptedProvider: "local-whisper",
              fallbackReason: "CUDA out of memory",
            },
            startedAt: "2026-05-27T09:05:00Z",
          },
        ],
      })
    )

    expect(md).toContain("Fallback from local-whisper")
    expect(md).toContain("CUDA out of memory")
  })
})
