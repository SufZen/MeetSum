import { describe, expect, it } from "vitest"

import { getMeetingWorkStatus } from "@/lib/meetings/work-status"
import type { JobRecord, MeetingRecord } from "@/lib/meetings/repository"

function meeting(overrides: Partial<MeetingRecord> = {}): MeetingRecord {
  return {
    id: "meeting_1",
    title: "Client review",
    source: "google_meet",
    language: "mixed",
    status: "scheduled",
    retention: "audio",
    startedAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    participants: [],
    ...overrides,
  }
}

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job_1",
    name: "artifact.import",
    status: "queued",
    meetingId: "meeting_1",
    payload: {},
    result: {},
    attempts: 0,
    maxAttempts: 3,
    retryable: true,
    createdAt: "2026-05-07T10:00:00.000Z",
    updatedAt: "2026-05-07T10:00:00.000Z",
    ...overrides,
  }
}

describe("meeting work status", () => {
  it("shows active processing stage from the latest job", () => {
    const status = getMeetingWorkStatus(
      meeting({ status: "summarizing" }),
      [
        job({
          status: "active",
          result: { stage: "summary.generate" },
          updatedAt: "2026-05-07T10:05:00.000Z",
        }),
      ]
    )

    expect(status).toMatchObject({
      kind: "processing",
      title: "Generating summary",
      primaryAction: "none",
      stage: "summary.generate",
      jobId: "job_1",
      progress: 0.65,
    })
  })

  it("turns failed jobs into retryable recovery guidance", () => {
    const status = getMeetingWorkStatus(
      meeting({ status: "failed" }),
      [
        job({
          status: "failed",
          result: { stage: "audio.transcribe" },
          error: "Gemini audio request failed",
        }),
      ]
    )

    expect(status).toMatchObject({
      kind: "failed",
      title: "Processing failed",
      primaryAction: "retry",
      description: "Gemini audio request failed",
      jobId: "job_1",
      retryable: true,
    })
  })

  it("marks linked artifacts as ready to process when no job is running", () => {
    const status = getMeetingWorkStatus(
      meeting({
        meetConferenceRecords: [
          {
            id: "conf_1",
            conferenceRecordName: "conferenceRecords/abc",
            artifacts: [
              {
                id: "artifact_1",
                conferenceRecordId: "conf_1",
                conferenceRecordName: "conferenceRecords/abc",
                artifactType: "transcript",
                artifactName: "conferenceRecords/abc/transcripts/t1",
              },
            ],
          },
        ],
      }),
      []
    )

    expect(status).toMatchObject({
      kind: "ready",
      title: "Ready to process",
      primaryAction: "process",
    })
  })

  it("marks future Google meetings as capture armed", () => {
    const status = getMeetingWorkStatus(meeting(), [])

    expect(status).toMatchObject({
      kind: "upcoming",
      title: "Capture armed",
      primaryAction: "sync_artifacts",
    })
  })
})
