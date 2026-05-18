import { describe, expect, it } from "vitest"

import { getMeetingCaptureReadiness } from "@/lib/meetings/capture-readiness"
import { groupFailedJobsByStageAndError } from "@/components/job-recovery-panel"
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

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    name: "audio.transcribe",
    status: "completed",
    payload: {},
    result: {},
    attempts: 1,
    maxAttempts: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

describe("meeting capture readiness", () => {
  it("marks linked Meet content artifacts as ready to process", () => {
    const readiness = getMeetingCaptureReadiness(
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
                artifactType: "smart_notes",
                artifactName: "conferenceRecords/abc/smartNotes/note",
              },
            ],
          },
        ],
      })
    )

    expect(readiness.status).toBe("ready_to_process")
    expect(readiness.primaryAction).toBe("process")
    expect(readiness.checks).toContainEqual(
      expect.objectContaining({
        key: "smart_notes",
        state: "ready",
      })
    )
  })

  it("marks future Google Meet meetings as capture armed", () => {
    const readiness = getMeetingCaptureReadiness(meeting())

    expect(readiness.status).toBe("capture_armed")
    expect(readiness.primaryAction).toBe("sync_artifacts")
    expect(readiness.title).toBe("Capture armed")
  })

  it("asks past empty Google meetings to sync artifacts", () => {
    const readiness = getMeetingCaptureReadiness(
      meeting({
        startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      })
    )

    expect(readiness.status).toBe("needs_artifact_sync")
    expect(readiness.primaryAction).toBe("sync_artifacts")
  })

  it("routes non-Google meetings to manual capture", () => {
    const readiness = getMeetingCaptureReadiness(
      meeting({
        source: "upload",
      })
    )

    expect(readiness.status).toBe("manual_capture")
    expect(readiness.primaryAction).toBe("upload")
  })
})

describe("job recovery grouping", () => {
  it("groups failed jobs by stage and normalized error pattern", () => {
    const jobs: JobRecord[] = [
      makeJob({
        id: "j-1",
        status: "failed",
        meetingId: "m-1",
        result: { stage: "audio.transcribe" },
        error: "Error: ETIMEDOUT connect",
      }),
      makeJob({
        id: "j-2",
        status: "failed",
        meetingId: "m-2",
        result: { stage: "audio.transcribe" },
        error: "Error: timeout waiting for response",
      }),
      makeJob({
        id: "j-3",
        status: "failed",
        meetingId: "m-3",
        result: { stage: "summary.generate" },
        error: "Error: 429 too many requests rate limit",
      }),
    ]
    const meetings = [
      meeting({ id: "m-1", title: "Meeting Alpha" }),
      meeting({ id: "m-2", title: "Meeting Beta" }),
      meeting({ id: "m-3", title: "Meeting Gamma" }),
    ]

    const groups = groupFailedJobsByStageAndError(jobs, meetings)
    const transcribeGroup = groups.find(
      (group) => group.stage === "audio.transcribe"
    )

    expect(transcribeGroup).toBeDefined()
    expect(transcribeGroup!.jobs.length).toBe(2)
    expect(transcribeGroup!.errorPattern).toBe("Timeout")

    const summaryGroup = groups.find(
      (group) => group.stage === "summary.generate"
    )

    expect(summaryGroup).toBeDefined()
    expect(summaryGroup!.jobs.length).toBe(1)
    expect(summaryGroup!.errorPattern).toBe("Rate limited")
  })

  it("excludes non-failed jobs from recovery groups", () => {
    const jobs: JobRecord[] = [
      makeJob({ id: "j-ok", status: "completed", meetingId: "m-1" }),
      makeJob({ id: "j-q", status: "queued", meetingId: "m-2" }),
    ]

    const groups = groupFailedJobsByStageAndError(jobs, [])

    expect(groups.length).toBe(0)
  })

  it("resolves meeting titles for grouped job entries", () => {
    const jobs: JobRecord[] = [
      makeJob({
        id: "j-1",
        status: "failed",
        meetingId: "m-1",
        error: "Auth error 401",
        result: { stage: "audio.transcribe" },
      }),
    ]
    const meetings = [meeting({ id: "m-1", title: "Board Review Q3" })]

    const groups = groupFailedJobsByStageAndError(jobs, meetings)

    expect(groups[0].jobs[0].meetingTitle).toBe("Board Review Q3")
    expect(groups[0].errorPattern).toBe("Authentication error")
  })

  it("normalizes error patterns case-insensitively", () => {
    const jobs: JobRecord[] = [
      makeJob({
        id: "j-ci-1",
        status: "failed",
        meetingId: "m-1",
        result: { stage: "audio.transcribe" },
        error: "Connection Timeout after 30s",
      }),
      makeJob({
        id: "j-ci-2",
        status: "failed",
        meetingId: "m-2",
        result: { stage: "summary.generate" },
        error: "ECONNREFUSED 127.0.0.1:5000",
      }),
    ]

    const groups = groupFailedJobsByStageAndError(jobs, [])

    expect(groups.find((g) => g.stage === "audio.transcribe")?.errorPattern).toBe("Timeout")
    expect(groups.find((g) => g.stage === "summary.generate")?.errorPattern).toBe("Connection refused")
  })

  it("does not falsely match 'rate' inside unrelated words", () => {
    const jobs: JobRecord[] = [
      makeJob({
        id: "j-fp",
        status: "failed",
        meetingId: "m-1",
        result: { stage: "summary.generate" },
        error: "Failed to generate summary",
      }),
    ]

    const groups = groupFailedJobsByStageAndError(jobs, [])

    expect(groups[0].errorPattern).not.toBe("Rate limited")
    expect(groups[0].errorPattern).toBe("Failed to generate summary")
  })
})

