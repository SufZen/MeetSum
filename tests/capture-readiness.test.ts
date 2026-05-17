import { describe, expect, it } from "vitest"

import { getMeetingCaptureReadiness } from "@/lib/meetings/capture-readiness"
import type { MeetingRecord } from "@/lib/meetings/repository"

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
