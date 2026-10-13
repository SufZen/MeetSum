import { beforeEach, describe, expect, it, vi } from "vitest"

import type { MeetingRecord, MeetingRepository } from "@/lib/meetings/repository"

import { mockAuthzModule, testAuthContext, testAuthState } from "./helpers/auth-context"

const mocks = vi.hoisted(() => ({
  getMeeting: vi.fn(),
  enqueueMeetSumJob: vi.fn(),
  settings: { googleArtifactsFirst: true } as Record<string, unknown>,
}))

vi.mock("@/lib/auth/authz", async (importOriginal) => mockAuthzModule(importOriginal))

vi.mock("@/lib/jobs/queue", () => ({
  enqueueMeetSumJob: mocks.enqueueMeetSumJob,
}))

vi.mock("@/lib/settings/app-settings", () => ({
  getAppSettings: vi.fn(async () => mocks.settings),
}))

const { POST } = await import("@/app/api/meetings/[id]/process/route")

function meetingWith(overrides: Partial<MeetingRecord>): MeetingRecord {
  return {
    id: "meet_1",
    title: "Weekly",
    source: "google_meet",
    language: "he",
    status: "scheduled",
    retention: "audio",
    startedAt: "2026-10-12T10:00:00.000Z",
    participants: [],
    ...overrides,
  } as MeetingRecord
}

const recording = {
  id: "asset_1",
  meetingId: "meet_1",
  storageKey: "meetings/meet_1/a.m4a",
  contentType: "audio/mp4",
  sizeBytes: 1,
  retention: "audio",
  createdAt: "2026-10-12T10:00:00.000Z",
}

function conferenceWith(...artifactTypes: string[]) {
  return [
    {
      id: "conf_1",
      conferenceRecordName: "conferenceRecords/1",
      artifacts: artifactTypes.map((artifactType, index) => ({
        id: `artifact_${index}`,
        artifactType,
        artifactName: `a/${index}`,
      })),
    },
  ]
}

async function process() {
  return POST(new Request("http://localhost/api/meetings/meet_1/process", { method: "POST" }), {
    params: Promise.resolve({ id: "meet_1" }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.settings = { googleArtifactsFirst: true }
  mocks.enqueueMeetSumJob.mockImplementation(async (name: string) => ({ id: "job_1", name }))
  testAuthState.ctx = testAuthContext({
    workspaceId: "ws_1",
    role: "member",
    meetings: { getMeeting: mocks.getMeeting } as unknown as MeetingRepository,
  })
})

describe("POST /api/meetings/[id]/process", () => {
  it("prefers Google's transcript artifact over ASR when googleArtifactsFirst is on", async () => {
    mocks.getMeeting.mockResolvedValue(
      meetingWith({
        mediaAssets: [recording] as MeetingRecord["mediaAssets"],
        meetConferenceRecords: conferenceWith("transcript", "recording") as MeetingRecord["meetConferenceRecords"],
      })
    )

    const response = await process()

    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({ mode: "meet-content-artifact" })
    expect(mocks.enqueueMeetSumJob).toHaveBeenCalledWith(
      "artifact.import",
      expect.objectContaining({ meetingId: "meet_1", workspaceId: "ws_1" })
    )
  })

  it("transcribes the recording when googleArtifactsFirst is off", async () => {
    mocks.settings = { googleArtifactsFirst: false }
    mocks.getMeeting.mockResolvedValue(
      meetingWith({
        mediaAssets: [recording] as MeetingRecord["mediaAssets"],
        meetConferenceRecords: conferenceWith("transcript") as MeetingRecord["meetConferenceRecords"],
      })
    )

    const response = await process()

    expect(await response.json()).toMatchObject({ mode: "media" })
    expect(mocks.enqueueMeetSumJob).toHaveBeenCalledWith(
      "media.ingest",
      expect.objectContaining({ assetId: "asset_1", workspaceId: "ws_1" })
    )
  })

  it("does not import artifacts over an existing transcript", async () => {
    mocks.getMeeting.mockResolvedValue(
      meetingWith({
        transcript: [{ id: "s1", speaker: "A", startMs: 0, endMs: 1, text: "hi" }],
        meetConferenceRecords: conferenceWith("transcript") as MeetingRecord["meetConferenceRecords"],
      })
    )

    const response = await process()

    expect(await response.json()).toMatchObject({ mode: "transcript" })
    expect(mocks.enqueueMeetSumJob.mock.calls[0][0]).toBe("meeting.summarize")
  })

  it("a recording-only artifact does not pre-empt an attached recording", async () => {
    mocks.getMeeting.mockResolvedValue(
      meetingWith({
        mediaAssets: [recording] as MeetingRecord["mediaAssets"],
        meetConferenceRecords: conferenceWith("recording") as MeetingRecord["meetConferenceRecords"],
      })
    )

    const response = await process()

    expect(await response.json()).toMatchObject({ mode: "media" })
  })

  it("answers 404 for a meeting the caller cannot see", async () => {
    mocks.getMeeting.mockResolvedValue(undefined)

    const response = await process()

    expect(response.status).toBe(404)
    expect(mocks.enqueueMeetSumJob).not.toHaveBeenCalled()
  })

  it("requires meeting:write", async () => {
    testAuthState.ctx = testAuthContext({ role: "viewer" })

    const response = await process()

    expect(response.status).toBe(403)
  })
})
