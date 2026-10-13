import { describe, expect, it } from "vitest"

import { getDictionary } from "@/lib/i18n/dictionaries"
import { getMeetingWorkStatus, meetingStageMessageKey } from "@/lib/meetings/work-status"
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
      primaryAction: "none",
      jobStatus: "active",
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
      primaryAction: "retry",
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
      readiness: "ready_to_process",
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
      readiness: "processed",
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
      progress: 0.7,
    })
  })

  it("maps the summary.persist stage to a dictionary key (gender-neutral Hebrew)", () => {
    const key = meetingStageMessageKey("summary.persist")!
    const he = getDictionary("he") as Record<string, string>
    const en = getDictionary("en") as Record<string, string>

    expect(en[key]).toBe("Saving summary")
    expect(he[key]).toBe("שמירת הסיכום")
    expect(meetingStageMessageKey("unknown.stage")).toBeUndefined()
  })

  it("returns codes, never English or Hebrew copy (M9)", () => {
    const status = getMeetingWorkStatus(meeting(), [])

    expect(status).not.toHaveProperty("title")
    expect(status).not.toHaveProperty("description")
    for (const check of status.checks) expect(check).not.toHaveProperty("label")
  })

  it("marks future Google meetings as capture armed", () => {
    const status = getMeetingWorkStatus(meeting(), [])

    expect(status).toMatchObject({
      kind: "upcoming",
      readiness: "capture_armed",
      primaryAction: "sync_artifacts",
    })
  })
})
