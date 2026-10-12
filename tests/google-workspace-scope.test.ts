import { writeFileSync } from "node:fs"
import { Readable } from "node:stream"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  repositoryWorkspaces: [] as string[],
  getMeeting: vi.fn(),
  createMeeting: vi.fn(),
  createMediaAsset: vi.fn(),
  enqueueMeetSumJob: vi.fn(),
  storeMeetingObject: vi.fn(),
  settings: {} as Record<string, unknown>,
  calendarListList: vi.fn(),
  eventsList: vi.fn(),
  filesGet: vi.fn(),
}))

vi.mock("@/lib/db/client", () => ({
  getDatabasePool: () => ({
    query: mocks.query,
    connect: async () => ({ query: mocks.query, release: mocks.release }),
  }),
}))

vi.mock("@/lib/google/auth", () => ({
  createDelegatedGoogleClient: vi.fn(async () => ({})),
}))

vi.mock("googleapis", () => ({
  google: {
    calendar: () => ({
      calendarList: { list: mocks.calendarListList },
      events: { list: mocks.eventsList },
    }),
    drive: () => ({ files: { get: mocks.filesGet, list: vi.fn() } }),
    gmail: () => ({}),
  },
}))

vi.mock("node:child_process", () => ({
  // ffmpeg stand-in: writes the requested output file.
  execFile: (
    _command: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, result: { stdout: string; stderr: string }) => void
  ) => {
    writeFileSync(args[args.length - 1], "audio-bytes")
    callback(null, { stdout: "", stderr: "" })
  },
}))

vi.mock("@/lib/meetings/store", () => ({
  getSystemMeetingRepository: (workspaceId: string) => {
    mocks.repositoryWorkspaces.push(workspaceId)
    return {
      getMeeting: mocks.getMeeting,
      createMeeting: mocks.createMeeting,
      createMediaAsset: mocks.createMediaAsset,
    }
  },
}))

vi.mock("@/lib/settings/app-settings", () => ({
  getAppSettings: vi.fn(async () => mocks.settings),
}))

vi.mock("@/lib/jobs/queue", () => ({
  enqueueMeetSumJob: mocks.enqueueMeetSumJob,
}))

vi.mock("@/lib/storage/object-storage", () => ({
  storeMeetingObject: mocks.storeMeetingObject,
}))

const { pollCalendar, importDriveRecordings } = await import("@/lib/google/services")
const { listMeetingTranscriptArtifactCandidates, listMeetingRecordingArtifactCandidates } =
  await import("@/lib/google/meet-artifacts")

const W2 = { subject: "owner@w2.test", workspaceId: "ws_2" }

function callsMatching(pattern: RegExp) {
  return mocks.query.mock.calls.filter(([sql]) => pattern.test(sql as string))
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.repositoryWorkspaces.length = 0
  mocks.settings = {
    autoProcessImportedMedia: true,
    retainVideoByDefault: false,
    meetingLanguageMode: "en",
    defaultMeetingVisibility: "private",
  }
  mocks.query.mockImplementation(async (sql: string) => {
    if (/insert into google_identities/.test(sql)) return { rows: [{ id: "gident_w2" }] }
    if (/insert into calendar_events/.test(sql)) {
      return { rows: [{ id: "gcal_1", inserted: true }] }
    }
    if (/insert into meetings/.test(sql)) return { rows: [{ id: "meet_google_1" }] }
    if (/insert into drive_files/.test(sql)) return { rows: [{ id: "gdrive_1" }] }
    return { rows: [] }
  })
  mocks.createMeeting.mockImplementation(async (input: Record<string, unknown>) => ({
    id: "meet_drive_1",
    ...input,
  }))
  mocks.storeMeetingObject.mockImplementation(
    async (input: { meetingId: string; filename: string; contentType: string }) => ({
      key: `meetings/${input.meetingId}/${input.filename}`,
      bucket: "meeting-media",
      contentType: input.contentType,
      sizeBytes: 11,
    })
  )
  mocks.enqueueMeetSumJob.mockResolvedValue({ id: "job_1" })
})

describe("pollCalendar workspace scoping", () => {
  beforeEach(() => {
    mocks.calendarListList.mockResolvedValue({
      data: { items: [{ id: "primary", summary: "Owner" }] },
    })
    mocks.eventsList.mockResolvedValue({
      data: {
        items: [
          {
            id: "evt_1",
            summary: "Roadmap review",
            status: "confirmed",
            start: { dateTime: "2026-10-12T10:00:00Z" },
            end: { dateTime: "2026-10-12T11:00:00Z" },
            hangoutLink: "https://meet.google.com/abc-defg-hij",
            attendees: [{ email: "guest@w2.test", responseStatus: "accepted" }],
          },
        ],
      },
    })
  })

  it("uses the workspace's own Google identity", async () => {
    await pollCalendar(W2)

    const [identity] = callsMatching(/insert into google_identities/)
    expect(identity[1]).toEqual([
      expect.any(String),
      "wsacct_ws_2",
      "owner@w2.test",
      "ws_2",
    ])
  })

  it("creates meetings in the workspace with its visibility, language and owner", async () => {
    await pollCalendar(W2)

    const [[sql, values]] = callsMatching(/insert into meetings/)
    expect(sql).toMatch(/workspace_id, owner_user_id, visibility/)
    expect(sql).toMatch(/where meetings\.workspace_id = excluded\.workspace_id/)
    expect(sql).toMatch(/select id from users where lower\(email\) = lower\(\$9\)/)
    expect(values).toEqual(
      expect.arrayContaining(["ws_2", "owner@w2.test", "private", "en"])
    )
    const [[lookup, lookupValues]] = callsMatching(/select id from meetings/)
    expect(lookup).toMatch(/workspace_id = \$2/)
    expect(lookupValues).toEqual(["gcal_1", "ws_2"])
    expect(callsMatching(/insert into meeting_participants/).length).toBeGreaterThan(0)
  })

  it("never touches a same-id meeting of another workspace", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (/insert into calendar_events/.test(sql)) {
        return { rows: [{ id: "gcal_1", inserted: false }] }
      }
      // The guarded upsert updates nothing → no row returned.
      return { rows: [] }
    })

    await pollCalendar(W2)

    expect(callsMatching(/insert into meeting_participants/)).toHaveLength(0)
  })

  it("scopes cancellations to the workspace", async () => {
    mocks.eventsList.mockResolvedValue({
      data: { items: [{ id: "evt_1", status: "cancelled", summary: "x" }] },
    })

    await pollCalendar(W2)

    const [[sql, values]] = callsMatching(/update meetings set status = 'failed'/)
    expect(sql).toMatch(/workspace_id = \$2/)
    expect(values).toEqual(["gcal_1", "ws_2"])
  })
})

describe("importDriveRecordings workspace scoping + settings effects", () => {
  function driveFile(mimeType: string, name = "Meet recording.m4a") {
    mocks.filesGet.mockImplementation(async (params: { alt?: string }) =>
      params.alt === "media"
        ? { data: Readable.from([Buffer.from("raw-media")]) }
        : {
            data: {
              id: "file_1",
              name,
              mimeType,
              size: "100",
              createdTime: "2026-10-12T10:00:00Z",
            },
          }
    )
  }

  it("creates the meeting in the workspace and enqueues with its workspaceId", async () => {
    driveFile("audio/mp4")

    const result = await importDriveRecordings(W2, ["file_1"], { ownerUserId: "user_1" })

    expect(new Set(mocks.repositoryWorkspaces)).toEqual(new Set(["ws_2"]))
    expect(mocks.createMeeting).toHaveBeenCalledWith(
      expect.objectContaining({
        language: "en",
        visibility: "private",
        ownerUserId: "user_1",
      })
    )
    expect(mocks.enqueueMeetSumJob).toHaveBeenCalledWith(
      "media.ingest",
      expect.objectContaining({ meetingId: "meet_drive_1", workspaceId: "ws_2" })
    )
    expect(result.files[0]).toMatchObject({ status: "queued", jobId: "job_1" })
    const [[lockSql, lockValues]] = callsMatching(/from drive_files df/)
    expect(lockSql).toMatch(/workspace_id = \$2/)
    expect(lockValues).toEqual(["gdrive_1", "ws_2"])
  })

  it("stores but does not process when autoProcessImportedMedia is off", async () => {
    mocks.settings.autoProcessImportedMedia = false
    driveFile("audio/mp4")

    const result = await importDriveRecordings(W2, ["file_1"])

    expect(mocks.enqueueMeetSumJob).not.toHaveBeenCalled()
    expect(mocks.createMediaAsset).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ imported: 1, jobs: [] })
    expect(result.files[0]).toMatchObject({ status: "imported", meetingId: "meet_drive_1" })
  })

  it("keeps the original video next to the audio when retainVideoByDefault is on", async () => {
    mocks.settings.retainVideoByDefault = true
    driveFile("video/mp4", "Meet recording.mp4")

    await importDriveRecordings(W2, ["file_1"])

    expect(mocks.createMediaAsset.mock.calls.map(([input]) => input.retention)).toEqual([
      "video",
      "audio",
    ])
    expect(mocks.storeMeetingObject.mock.calls[0][0]).toMatchObject({
      contentType: "video/mp4",
    })
    expect(mocks.enqueueMeetSumJob.mock.calls[0][1]).toMatchObject({
      storageKey: "meetings/meet_drive_1/Meet recording.m4a",
    })
  })

  it("drops the video when retainVideoByDefault is off", async () => {
    driveFile("video/mp4", "Meet recording.mp4")

    await importDriveRecordings(W2, ["file_1"])

    expect(mocks.createMediaAsset.mock.calls.map(([input]) => input.retention)).toEqual([
      "audio",
    ])
  })
})

describe("Meet artifact candidates are workspace-scoped", () => {
  it.each([
    ["transcript", listMeetingTranscriptArtifactCandidates],
    ["recording", listMeetingRecordingArtifactCandidates],
  ] as const)("%s candidates join the workspace's identities and meeting", async (_label, list) => {
    await list({ meetingId: "meet_1", workspaceId: "ws_2" })

    const [sql, values] = mocks.query.mock.calls[0]
    expect(sql).toMatch(/select id from google_identities where workspace_id = \$2/)
    expect(sql).toMatch(/where id = \$1 and workspace_id = \$2/)
    expect(values).toEqual(["meet_1", "ws_2"])
  })
})
