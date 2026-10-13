import { beforeEach, describe, expect, it, vi } from "vitest"

import { streamedMultipartRequest, wavFile } from "./helpers/multipart"

const mocks = vi.hoisted(() => ({
  getMeeting: vi.fn(),
  createMeeting: vi.fn(),
  createMeetingIfAbsent: vi.fn(),
  findMeetingByExternalId: vi.fn(),
  discardMeeting: vi.fn(),
  createMediaAsset: vi.fn(),
  findMediaAssetBySourceFile: vi.fn(),
  replaceTranscriptSegments: vi.fn(),
  listJobs: vi.fn(),
  enqueueMeetSumJob: vi.fn(),
  storeMeetingObjectStream: vi.fn(),
  deleteMeetingObject: vi.fn(),
}))

vi.mock("@/lib/api/responses", async () => {
  const { NextResponse } = await import("next/server")

  return {
    requireAppAccess: vi.fn(async () => undefined),
    jsonError: (message: string, status = 400) =>
      NextResponse.json({ error: message }, { status }),
  }
})

vi.mock("@/lib/meetings/store", () => ({
  meetingRepository: {
    getMeeting: mocks.getMeeting,
    createMeeting: mocks.createMeeting,
    createMeetingIfAbsent: mocks.createMeetingIfAbsent,
    findMeetingByExternalId: mocks.findMeetingByExternalId,
    discardMeeting: mocks.discardMeeting,
    createMediaAsset: mocks.createMediaAsset,
    findMediaAssetBySourceFile: mocks.findMediaAssetBySourceFile,
    replaceTranscriptSegments: mocks.replaceTranscriptSegments,
    listJobs: mocks.listJobs,
  },
}))

vi.mock("@/lib/jobs/queue", () => ({
  enqueueMeetSumJob: mocks.enqueueMeetSumJob,
}))

vi.mock("@/lib/storage/object-storage", () => ({
  storeMeetingObjectStream: mocks.storeMeetingObjectStream,
  deleteMeetingObject: mocks.deleteMeetingObject,
}))

function formWith(fields: Record<string, unknown>) {
  const form = new FormData()

  // Fields first, file last — mirrors the shell and desktop companion.
  for (const [key, value] of Object.entries(fields)) {
    if (!(value instanceof File)) form.append(key, JSON.stringify(value))
  }
  for (const [key, value] of Object.entries(fields)) {
    if (value instanceof File) form.append(key, value)
  }

  return form
}

const knownMeeting = {
  id: "meet_known",
  title: "Known",
  source: "upload",
  language: "he",
  status: "created",
  retention: "audio",
  startedAt: "2026-07-05T09:00:00.000Z",
  participants: [],
}

const desktopMeeting = {
  ...knownMeeting,
  id: "meet_desktop",
  title: "Desktop capture",
  source: "desktop_recorder",
}

function uploadRequest(form: FormData, meetingId = "meet_known") {
  return streamedMultipartRequest(
    `http://localhost/api/meetings/${meetingId}/upload`,
    form
  )
}

function ingestRequest(form: FormData) {
  return streamedMultipartRequest(
    "http://localhost/api/desktop-capture/ingest",
    form
  )
}

describe("desktop capture upload routes", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getMeeting.mockImplementation(async (id: string) =>
      id === "meet_known" ? knownMeeting : undefined
    )
    mocks.storeMeetingObjectStream.mockImplementation(
      async (input: {
        keyPrefix: string
        filename: string
        contentType: string
        body: AsyncIterable<Buffer>
      }) => {
        let sizeBytes = 0
        for await (const chunk of input.body) sizeBytes += chunk.length
        return {
          key: `${input.keyPrefix}/stored-${input.filename}`,
          bucket: "meeting-media",
          sizeBytes,
          contentType: input.contentType,
          checksumSha256: "sha-new",
        }
      }
    )
    mocks.deleteMeetingObject.mockResolvedValue(undefined)
    mocks.createMediaAsset.mockImplementation(async (input: Record<string, unknown>) => ({
      id: "asset_1",
      createdAt: "2026-07-05T09:00:00.000Z",
      ...input,
    }))
    mocks.findMediaAssetBySourceFile.mockResolvedValue(undefined)
    mocks.findMeetingByExternalId.mockResolvedValue(undefined)
    mocks.createMeeting.mockResolvedValue(desktopMeeting)
    mocks.createMeetingIfAbsent.mockResolvedValue({
      meeting: desktopMeeting,
      created: true,
    })
    mocks.discardMeeting.mockResolvedValue(true)
    mocks.replaceTranscriptSegments.mockResolvedValue([])
    mocks.listJobs.mockResolvedValue([])
    mocks.enqueueMeetSumJob.mockResolvedValue({
      id: "job_1",
      name: "meeting.summarize",
      status: "queued",
    })
  })

  it("streams known-meeting uploads to storage without buffering the body", async () => {
    const formDataSpy = vi.spyOn(Request.prototype, "formData")
    const arrayBufferSpy = vi.spyOn(Request.prototype, "arrayBuffer")
    const { POST } = await import("@/app/api/meetings/[id]/upload/route")
    const response = await POST(await uploadRequest(formWith({ file: wavFile() })), {
      params: Promise.resolve({ id: "meet_known" }),
    })

    expect(response.status).toBe(202)
    expect(formDataSpy).not.toHaveBeenCalled()
    expect(arrayBufferSpy).not.toHaveBeenCalled()
    expect(mocks.storeMeetingObjectStream).toHaveBeenCalledWith(
      expect.objectContaining({
        keyPrefix: "meetings/meet_known",
        filename: "meeting.wav",
        contentType: "audio/wav",
      })
    )
    expect(mocks.createMediaAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        meetingId: "meet_known",
        storageKey: "meetings/meet_known/stored-meeting.wav",
        sizeBytes: 64,
        checksumSha256: "sha-new",
        retention: "audio",
      })
    )
    expect(mocks.createMediaAsset).toHaveBeenCalledWith(
      expect.not.objectContaining({ source: "desktop_capture" })
    )
    expect(mocks.enqueueMeetSumJob).toHaveBeenCalledWith(
      "media.ingest",
      expect.objectContaining({
        meetingId: "meet_known",
        assetId: "asset_1",
        storageKey: "meetings/meet_known/stored-meeting.wav",
        bucket: "meeting-media",
      })
    )
    expect(mocks.enqueueMeetSumJob).toHaveBeenCalledWith(
      "media.ingest",
      expect.not.objectContaining({ mode: "desktop-media" })
    )
    formDataSpy.mockRestore()
    arrayBufferSpy.mockRestore()
  })

  it("returns 404 for unknown meetings before reading the upload", async () => {
    const { POST } = await import("@/app/api/meetings/[id]/upload/route")
    const response = await POST(
      await uploadRequest(formWith({ file: wavFile() }), "meet_missing"),
      { params: Promise.resolve({ id: "meet_missing" }) }
    )

    expect(response.status).toBe(404)
    expect(mocks.storeMeetingObjectStream).not.toHaveBeenCalled()
  })

  it("maps non-multipart bodies to 415 and bad media to 415", async () => {
    const { POST } = await import("@/app/api/meetings/[id]/upload/route")
    const json = await POST(
      new Request("http://localhost/api/meetings/meet_known/upload", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({ id: "meet_known" }) }
    )

    expect(json.status).toBe(415)

    const notAudio = await POST(
      await uploadRequest(
        formWith({
          file: new File(["plain text pretending to be audio"], "a.wav", {
            type: "audio/wav",
          }),
        })
      ),
      { params: Promise.resolve({ id: "meet_known" }) }
    )

    expect(notAudio.status).toBe(415)
    expect(mocks.createMediaAsset).not.toHaveBeenCalled()
  })

  it("maps oversized uploads to 413", async () => {
    vi.stubEnv("MEETSUM_MAX_UPLOAD_BYTES", "100")
    const { POST } = await import("@/app/api/meetings/[id]/upload/route")
    const response = await POST(
      await uploadRequest(formWith({ file: wavFile("big.wav", 10_000) })),
      { params: Promise.resolve({ id: "meet_known" }) }
    )

    expect(response.status).toBe(413)
    expect(mocks.createMediaAsset).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
  })

  it("summarizes a known desktop upload when local transcript segments are supplied", async () => {
    const { POST } = await import("@/app/api/meetings/[id]/upload/route")
    const response = await POST(
      await uploadRequest(
        formWith({
          file: wavFile(),
          transcript: [
            {
              text: "We agreed to keep MeetSum as the source of truth.",
              startMs: 0,
              endMs: 4200,
              confidence: 0.91,
            },
          ],
          captureMetadata: {
            sampleRate: 48000,
            localTranscription: { provider: "parakeet", model: "v3-int8" },
          },
        })
      ),
      { params: Promise.resolve({ id: "meet_known" }) }
    )

    expect(response.status).toBe(202)
    expect(mocks.createMediaAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        meetingId: "meet_known",
        source: "desktop_capture",
        metadata: expect.objectContaining({
          sampleRate: 48000,
          localTranscription: { provider: "parakeet", model: "v3-int8" },
        }),
      })
    )
    expect(mocks.replaceTranscriptSegments).toHaveBeenCalledWith(
      "meet_known",
      expect.arrayContaining([
        expect.objectContaining({
          text: "We agreed to keep MeetSum as the source of truth.",
          speaker: "Speaker 1",
        }),
      ])
    )
    expect(mocks.enqueueMeetSumJob).toHaveBeenCalledWith(
      "meeting.summarize",
      expect.objectContaining({
        meetingId: "meet_known",
        mode: "desktop-transcript",
      })
    )
  })

  it("skips re-uploading and reuses the existing job when a spooled retry repeats the capture id", async () => {
    const existingAsset = {
      id: "asset_existing",
      meetingId: "meet_known",
      storageKey: "meetings/known/existing.wav",
      contentType: "audio/wav",
      sizeBytes: 3,
      retention: "audio",
      source: "desktop_capture",
      sourceFileId: "capture_123",
      createdAt: "2026-07-05T09:00:00.000Z",
    }
    mocks.findMediaAssetBySourceFile.mockResolvedValue(existingAsset)
    mocks.listJobs.mockResolvedValue([
      {
        id: "job_existing",
        name: "media.ingest",
        status: "queued",
        payload: { assetId: "asset_existing" },
      },
    ])
    const { POST } = await import("@/app/api/meetings/[id]/upload/route")
    const response = await POST(
      await uploadRequest(
        formWith({
          captureMetadata: { captureId: "capture_123", uploadStatus: "retry" },
          file: wavFile(),
        })
      ),
      { params: Promise.resolve({ id: "meet_known" }) }
    )
    const body = await response.json()

    expect(response.status).toBe(202)
    expect(body).toMatchObject({ deduplicated: true, job: { id: "job_existing" } })
    expect(mocks.findMediaAssetBySourceFile).toHaveBeenCalledWith(
      "desktop_capture",
      "capture_123",
      { meetingId: "meet_known" }
    )
    expect(mocks.storeMeetingObjectStream).not.toHaveBeenCalled()
    expect(mocks.createMediaAsset).not.toHaveBeenCalled()
    expect(mocks.enqueueMeetSumJob).not.toHaveBeenCalled()
  })

  it("re-enqueues for an existing capture asset when the previous job failed", async () => {
    mocks.findMediaAssetBySourceFile.mockResolvedValue({
      id: "asset_existing",
      meetingId: "meet_known",
      storageKey: "meetings/known/existing.wav",
      contentType: "audio/wav",
      sizeBytes: 3,
      retention: "audio",
      createdAt: "2026-07-05T09:00:00.000Z",
    })
    mocks.listJobs.mockResolvedValue([
      { id: "job_old", status: "failed", payload: { assetId: "asset_existing" } },
    ])
    const { POST } = await import("@/app/api/meetings/[id]/upload/route")
    const response = await POST(
      await uploadRequest(
        formWith({
          captureMetadata: { captureId: "capture_123" },
          file: wavFile(),
        })
      ),
      { params: Promise.resolve({ id: "meet_known" }) }
    )

    expect(response.status).toBe(202)
    expect(mocks.enqueueMeetSumJob).toHaveBeenCalledWith(
      "media.ingest",
      expect.objectContaining({
        assetId: "asset_existing",
        storageKey: "meetings/known/existing.wav",
        mode: "desktop-media",
      })
    )
  })

  it("deletes the stored object when asset creation fails", async () => {
    mocks.createMediaAsset.mockRejectedValue(new Error("db down"))
    const { POST } = await import("@/app/api/meetings/[id]/upload/route")
    const response = await POST(await uploadRequest(formWith({ file: wavFile() })), {
      params: Promise.resolve({ id: "meet_known" }),
    })

    expect(response.status).toBe(500)
    expect(mocks.deleteMeetingObject).toHaveBeenCalledWith(
      "meetings/meet_known/stored-meeting.wav"
    )
  })

  it("creates a desktop recorder meeting for unknown companion uploads", async () => {
    const { POST } = await import("@/app/api/desktop-capture/ingest/route")
    const response = await POST(
      await ingestRequest(
        formWith({
          meeting: {
            title: "Desktop capture",
            startedAt: "2026-07-05T09:00:00.000Z",
            language: "he",
          },
          transcript: [
            {
              text: "Transcript came from the desktop companion.",
              startMs: 0,
              endMs: 2500,
            },
          ],
          captureMetadata: {
            appVersion: "0.1.0",
            uploadStatus: "retry",
          },
        })
      )
    )

    expect(response.status).toBe(202)
    expect(mocks.createMeeting).toHaveBeenCalledWith({
      title: "Desktop capture",
      source: "desktop_recorder",
      language: "he",
      startedAt: "2026-07-05T09:00:00.000Z",
      participants: [],
    })
    expect(mocks.replaceTranscriptSegments).toHaveBeenCalledWith(
      "meet_desktop",
      expect.arrayContaining([
        expect.objectContaining({
          text: "Transcript came from the desktop companion.",
        }),
      ])
    )
    expect(mocks.enqueueMeetSumJob).toHaveBeenCalledWith(
      "meeting.summarize",
      expect.objectContaining({
        meetingId: "meet_desktop",
        source: "desktop-capture",
        captureMetadata: expect.objectContaining({
          appVersion: "0.1.0",
          uploadStatus: "retry",
        }),
      })
    )
  })

  it("stores incoming media under _incoming and creates the meeting idempotently by capture id", async () => {
    const { POST } = await import("@/app/api/desktop-capture/ingest/route")
    const response = await POST(
      await ingestRequest(
        formWith({
          meeting: { title: "Desktop capture", startedAt: "2026-07-05T09:00:00.000Z" },
          captureMetadata: { captureId: "cap_9" },
          file: wavFile(),
        })
      )
    )

    expect(response.status).toBe(202)
    expect(mocks.storeMeetingObjectStream).toHaveBeenCalledWith(
      expect.objectContaining({
        keyPrefix: expect.stringMatching(/^meetings\/_incoming\/[0-9a-f-]{36}$/),
      })
    )
    expect(mocks.createMeetingIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Desktop capture",
        externalSource: "desktop_capture",
        externalId: "cap_9",
      })
    )
    expect(mocks.createMeeting).not.toHaveBeenCalled()
    expect(mocks.createMediaAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        meetingId: "meet_desktop",
        source: "desktop_capture",
        sourceFileId: "cap_9",
      })
    )
  })

  it("returns 200 deduplicated and deletes the new object for a duplicate desktop capture", async () => {
    mocks.createMeetingIfAbsent.mockResolvedValue({
      meeting: desktopMeeting,
      created: false,
    })
    // First lookup (while streaming) misses; the scoped lookup after the
    // meeting is resolved finds the asset stored by the original request.
    mocks.findMediaAssetBySourceFile
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({
        id: "asset_original",
        meetingId: "meet_desktop",
        storageKey: "meetings/_incoming/original/a.wav",
        contentType: "audio/wav",
        sizeBytes: 64,
        retention: "audio",
        createdAt: "2026-07-05T09:00:00.000Z",
      })
    mocks.findMeetingByExternalId.mockResolvedValue(desktopMeeting)
    mocks.listJobs.mockResolvedValue([
      { id: "job_original", status: "active", payload: { assetId: "asset_original" } },
    ])
    const { POST } = await import("@/app/api/desktop-capture/ingest/route")
    const response = await POST(
      await ingestRequest(
        formWith({
          meeting: { title: "Desktop capture", startedAt: "2026-07-05T09:00:00.000Z" },
          captureMetadata: { captureId: "cap_9" },
          file: wavFile(),
        })
      )
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ deduplicated: true, job: { id: "job_original" } })
    expect(mocks.deleteMeetingObject).toHaveBeenCalledTimes(1)
    expect(mocks.deleteMeetingObject).toHaveBeenCalledWith(
      expect.stringMatching(/^meetings\/_incoming\/.+\/stored-meeting\.wav$/)
    )
    expect(mocks.createMediaAsset).not.toHaveBeenCalled()
    expect(mocks.enqueueMeetSumJob).not.toHaveBeenCalled()
    expect(mocks.discardMeeting).not.toHaveBeenCalled()
  })

  it("skips streaming entirely when the capture's media is already stored", async () => {
    mocks.findMeetingByExternalId.mockResolvedValue(desktopMeeting)
    mocks.createMeetingIfAbsent.mockResolvedValue({
      meeting: desktopMeeting,
      created: false,
    })
    mocks.findMediaAssetBySourceFile.mockResolvedValue({
      id: "asset_original",
      meetingId: "meet_desktop",
      storageKey: "meetings/_incoming/original/a.wav",
      contentType: "audio/wav",
      sizeBytes: 64,
      retention: "audio",
      createdAt: "2026-07-05T09:00:00.000Z",
    })
    mocks.listJobs.mockResolvedValue([
      { id: "job_original", status: "completed", payload: { assetId: "asset_original" } },
    ])
    const { POST } = await import("@/app/api/desktop-capture/ingest/route")
    const response = await POST(
      await ingestRequest(
        formWith({
          meeting: { title: "Desktop capture", startedAt: "2026-07-05T09:00:00.000Z" },
          captureMetadata: { captureId: "cap_9" },
          file: wavFile(),
        })
      )
    )

    expect(response.status).toBe(200)
    expect(mocks.storeMeetingObjectStream).not.toHaveBeenCalled()
    expect(mocks.deleteMeetingObject).not.toHaveBeenCalled()
  })

  it("discards the new meeting and deletes the object when ingestion fails", async () => {
    mocks.enqueueMeetSumJob.mockRejectedValue(new Error("redis down"))
    const { POST } = await import("@/app/api/desktop-capture/ingest/route")
    const response = await POST(
      await ingestRequest(
        formWith({
          meeting: { title: "Desktop capture", startedAt: "2026-07-05T09:00:00.000Z" },
          captureMetadata: { captureId: "cap_fail" },
          file: wavFile(),
        })
      )
    )

    expect(response.status).toBe(500)
    expect(mocks.discardMeeting).toHaveBeenCalledWith("meet_desktop")
    expect(mocks.deleteMeetingObject).toHaveBeenCalledWith(
      expect.stringMatching(/^meetings\/_incoming\/.+\/stored-meeting\.wav$/)
    )
  })

  it("rejects unknown desktop capture payloads without media or transcript before creating a meeting", async () => {
    const { POST } = await import("@/app/api/desktop-capture/ingest/route")
    const response = await POST(
      await ingestRequest(
        formWith({
          meeting: {
            title: "Missing content",
            startedAt: "2026-07-05T09:00:00.000Z",
          },
        })
      )
    )

    await expect(response.json()).resolves.toMatchObject({
      error: "Audio/video file or transcript segments are required",
    })
    expect(response.status).toBe(400)
    expect(mocks.createMeeting).not.toHaveBeenCalled()
    expect(mocks.createMeetingIfAbsent).not.toHaveBeenCalled()
  })

  it("deletes the stored object when the meeting payload is invalid", async () => {
    const { POST } = await import("@/app/api/desktop-capture/ingest/route")
    const response = await POST(
      await ingestRequest(
        formWith({
          meeting: { startedAt: "2026-07-05T09:00:00.000Z" },
          file: wavFile(),
        })
      )
    )

    expect(response.status).toBe(400)
    expect(mocks.deleteMeetingObject).toHaveBeenCalledTimes(1)
    expect(mocks.createMeeting).not.toHaveBeenCalled()
  })
})
