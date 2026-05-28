import { describe, it, expect } from "vitest"

import { groupFailedJobsByMeeting } from "@/components/job-recovery-panel"
import type { JobRecord, MeetingRecord } from "@/lib/meetings/repository"

function makeJob(
  overrides: Partial<JobRecord> & { id: string; meetingId: string }
): JobRecord {
  return {
    name: "audio.transcribe",
    status: "failed",
    payload: {},
    result: {},
    error: "timeout",
    attempts: 1,
    maxAttempts: 3,
    createdAt: "2026-05-27T10:00:00Z",
    updatedAt: "2026-05-27T10:05:00Z",
    ...overrides,
  }
}

function makeMeeting(
  overrides: Partial<MeetingRecord> & { id: string }
): MeetingRecord {
  return {
    title: "Test meeting",
    source: "upload",
    language: "he",
    status: "completed",
    retention: "audio",
    startedAt: "2026-05-27T09:00:00Z",
    participants: [],
    isFavorite: false,
    ...overrides,
  }
}

describe("groupFailedJobsByMeeting", () => {
  it("groups failed jobs by meeting and detects stale failures", () => {
    const jobs: JobRecord[] = [
      makeJob({
        id: "j1",
        meetingId: "m1",
        name: "audio.transcribe",
        error: "Timeout",
        createdAt: "2026-05-27T10:00:00Z",
        updatedAt: "2026-05-27T10:01:00Z",
      }),
      makeJob({
        id: "j2",
        meetingId: "m1",
        name: "summary.generate",
        error: "Rate limited",
        createdAt: "2026-05-27T10:05:00Z",
        updatedAt: "2026-05-27T10:06:00Z",
      }),
      makeJob({
        id: "j3",
        meetingId: "m2",
        name: "audio.transcribe",
        error: "Connection refused",
        createdAt: "2026-05-27T11:00:00Z",
        updatedAt: "2026-05-27T11:01:00Z",
      }),
    ]

    const meetings: MeetingRecord[] = [
      makeMeeting({ id: "m1", title: "Completed call", status: "completed" }),
      makeMeeting({ id: "m2", title: "Active call", status: "transcribing" }),
    ]

    const groups = groupFailedJobsByMeeting(jobs, meetings)

    // Should have 2 meeting groups
    expect(groups).toHaveLength(2)

    // Most recent first (m2 has newer failure)
    expect(groups[0].meetingId).toBe("m2")
    expect(groups[0].meetingTitle).toBe("Active call")
    expect(groups[0].meetingStatus).toBe("transcribing")
    expect(groups[0].jobs).toHaveLength(1)

    // m1 is completed — these are stale failures
    expect(groups[1].meetingId).toBe("m1")
    expect(groups[1].meetingTitle).toBe("Completed call")
    expect(groups[1].meetingStatus).toBe("completed")
    expect(groups[1].jobs).toHaveLength(2)
  })

  it("completed meetings have stale failures that do not override status", () => {
    const jobs: JobRecord[] = [
      makeJob({
        id: "j-old",
        meetingId: "m1",
        name: "audio.transcribe",
        error: "Timeout",
        createdAt: "2026-05-26T10:00:00Z",
        updatedAt: "2026-05-26T10:01:00Z",
      }),
    ]

    const meetings: MeetingRecord[] = [
      makeMeeting({ id: "m1", title: "Already done", status: "completed" }),
    ]

    const groups = groupFailedJobsByMeeting(jobs, meetings)

    expect(groups).toHaveLength(1)
    expect(groups[0].meetingStatus).toBe("completed")
    // The meeting is completed — the old failure should be treated as stale
    // and NOT make the meeting look failed
  })

  it("returns empty when no failed jobs exist", () => {
    const jobs: JobRecord[] = [
      {
        id: "j1",
        meetingId: "m1",
        name: "audio.transcribe",
        status: "completed",
        payload: {},
        result: {},
        attempts: 1,
        maxAttempts: 3,
        createdAt: "2026-05-27T10:00:00Z",
        updatedAt: "2026-05-27T10:05:00Z",
      },
    ]
    const meetings: MeetingRecord[] = [
      makeMeeting({ id: "m1", title: "Healthy", status: "completed" }),
    ]

    const groups = groupFailedJobsByMeeting(jobs, meetings)
    expect(groups).toHaveLength(0)
  })

  it("shows latest stage and error per meeting", () => {
    const jobs: JobRecord[] = [
      makeJob({
        id: "j1",
        meetingId: "m1",
        name: "audio.transcribe",
        error: "Connection refused",
        createdAt: "2026-05-27T09:00:00Z",
        updatedAt: "2026-05-27T09:01:00Z",
      }),
      makeJob({
        id: "j2",
        meetingId: "m1",
        name: "summary.generate",
        error: "Rate limited",
        createdAt: "2026-05-27T10:00:00Z",
        updatedAt: "2026-05-27T10:01:00Z",
      }),
    ]

    const meetings: MeetingRecord[] = [
      makeMeeting({ id: "m1", title: "Multi-failure", status: "failed" }),
    ]

    const groups = groupFailedJobsByMeeting(jobs, meetings)

    expect(groups).toHaveLength(1)
    // The latest job (j2) should determine the displayed stage and error
    expect(groups[0].latestStage).toBe("summary.generate")
    expect(groups[0].latestError).toBe("Rate limited")
  })
})
