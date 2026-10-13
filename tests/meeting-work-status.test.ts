import { describe, expect, it } from "vitest"

import { getMeetingWorkStatus, meetingStageTitle } from "@/lib/meetings/work-status"
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

  it("keeps processed meetings completed even when an old failed job remains", () => {
    const status = getMeetingWorkStatus(
      meeting({
        status: "completed",
        summary: {
          overview: "The team agreed on the next setup step.",
          decisions: ["Proceed with the VPS setup."],
          actionItems: [],
        },
        transcript: [
          {
            id: "segment_1",
            speaker: "Ran",
            startMs: 0,
            endMs: 5000,
            text: "We should continue with the VPS setup.",
            language: "en",
            confidence: 0.9,
          },
        ],
      }),
      [
        job({
          id: "job_old_failed",
          status: "failed",
          result: { stage: "audio.transcribe" },
          error: "Old provider timeout",
          updatedAt: "2026-05-07T10:05:00.000Z",
        }),
      ]
    )

    expect(status).toMatchObject({
      kind: "completed",
      title: "Processed",
      primaryAction: "none",
      progress: 1,
    })
  })

  it("ignores background search-index jobs on a finished meeting (M6)", () => {
    const finished = meeting({
      status: "completed",
      summary: { overview: "Done.", decisions: [], actionItems: [] },
      transcript: [
        {
          id: "segment_1",
          speaker: "Ran",
          startMs: 0,
          endMs: 5000,
          text: "We should continue with the VPS setup.",
          language: "en",
          confidence: 0.9,
        },
      ],
    })

    for (const name of ["meeting.index", "search.index.sweep"]) {
      for (const jobStatus of ["queued", "active", "failed"] as const) {
        const status = getMeetingWorkStatus(finished, [
          job({
            id: "job_pipeline",
            name: "meeting.summarize",
            status: "completed",
            result: { stage: "completed" },
            updatedAt: "2026-05-07T10:00:00.000Z",
          }),
          job({
            id: "job_index",
            name,
            status: jobStatus,
            result: { stage: "meeting.index" },
            updatedAt: "2026-05-07T11:00:00.000Z",
          }),
        ])

        expect(status.kind, `${name} ${jobStatus}`).toBe("completed")
        expect(status.jobId, `${name} ${jobStatus}`).toBeUndefined()
      }
    }
  })

  it("still reports a real pipeline job that is newer than a background index job", () => {
    const status = getMeetingWorkStatus(meeting({ status: "summarizing" }), [
      job({
        id: "job_index",
        name: "meeting.index",
        status: "active",
        updatedAt: "2026-05-07T11:00:00.000Z",
      }),
      job({
        id: "job_summary",
        name: "meeting.summarize",
        status: "active",
        result: { stage: "summary.persist" },
        updatedAt: "2026-05-07T10:30:00.000Z",
      }),
    ])

    expect(status).toMatchObject({
      kind: "processing",
      jobId: "job_summary",
      stage: "summary.persist",
      title: "Saving summary",
      progress: 0.7,
    })
  })

  it("labels the summary.persist stage in Hebrew and English", () => {
    expect(meetingStageTitle("summary.persist", "en")).toBe("Saving summary")
    expect(meetingStageTitle("summary.persist", "he")).toBe("שומר את הסיכום")
    expect(meetingStageTitle("unknown.stage")).toBeUndefined()
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
