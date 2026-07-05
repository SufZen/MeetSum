import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  createMeeting: vi.fn(),
  createMediaAsset: vi.fn(),
  findMediaAssetBySourceFile: vi.fn(),
  replaceTranscriptSegments: vi.fn(),
  enqueueMeetSumJob: vi.fn(),
  storeMeetingObject: vi.fn(),
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
    createMeeting: mocks.createMeeting,
    createMediaAsset: mocks.createMediaAsset,
    findMediaAssetBySourceFile: mocks.findMediaAssetBySourceFile,
    replaceTranscriptSegments: mocks.replaceTranscriptSegments,
  },
}))

vi.mock("@/lib/jobs/queue", () => ({
  enqueueMeetSumJob: mocks.enqueueMeetSumJob,
}))

vi.mock("@/lib/storage/object-storage", () => ({
  storeMeetingObject: mocks.storeMeetingObject,
}))

function audioFile() {
  return new File([new Uint8Array([1, 2, 3])], "meeting.wav", {
    type: "audio/wav",
  })
}

function formWith(fields: Record<string, unknown>) {
  const form = new FormData()

  for (const [key, value] of Object.entries(fields)) {
    if (value instanceof File) form.set(key, value)
    else form.set(key, JSON.stringify(value))
  }

  return form
}

describe("desktop capture upload routes", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.storeMeetingObject.mockResolvedValue({
      key: "meetings/known/audio.wav",
      bucket: "meeting-media",
      sizeBytes: 3,
      contentType: "audio/wav",
    })
    mocks.createMediaAsset.mockResolvedValue({
      id: "asset_1",
      meetingId: "meet_known",
      storageKey: "meetings/known/audio.wav",
      contentType: "audio/wav",
      sizeBytes: 3,
      retention: "audio",
      source: "desktop_capture",
      createdAt: "2026-07-05T09:00:00.000Z",
    })
    mocks.findMediaAssetBySourceFile.mockResolvedValue(undefined)
    mocks.createMeeting.mockResolvedValue({
      id: "meet_desktop",
      title: "Desktop capture",
      source: "desktop_recorder",
      language: "he",
      status: "created",
      retention: "audio",
      startedAt: "2026-07-05T09:00:00.000Z",
      participants: [],
    })
    mocks.replaceTranscriptSegments.mockResolvedValue([])
    mocks.enqueueMeetSumJob.mockResolvedValue({
      id: "job_1",
      name: "meeting.summarize",
      status: "queued",
    })
  })

  it("summarizes a known desktop upload when local transcript segments are supplied", async () => {
    const { POST } = await import("@/app/api/meetings/[id]/upload/route")
    const response = await POST(
      new Request("http://localhost/api/meetings/meet_known/upload", {
        method: "POST",
        body: formWith({
          file: audioFile(),
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
        }),
      }),
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

  it("keeps ordinary known-meeting uploads on the standard media ingestion path", async () => {
    const { POST } = await import("@/app/api/meetings/[id]/upload/route")
    const response = await POST(
      new Request("http://localhost/api/meetings/meet_known/upload", {
        method: "POST",
        body: formWith({ file: audioFile() }),
      }),
      { params: Promise.resolve({ id: "meet_known" }) }
    )

    expect(response.status).toBe(202)
    expect(mocks.createMediaAsset).toHaveBeenCalledWith(
      expect.not.objectContaining({
        source: "desktop_capture",
      })
    )
    expect(mocks.enqueueMeetSumJob).toHaveBeenCalledWith(
      "media.ingest",
      expect.not.objectContaining({
        mode: "desktop-media",
        source: "desktop-capture",
      })
    )
  })

  it("creates a desktop recorder meeting for unknown companion uploads", async () => {
    const { POST } = await import("@/app/api/desktop-capture/ingest/route")
    const response = await POST(
      new Request("http://localhost/api/desktop-capture/ingest", {
        method: "POST",
        body: formWith({
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
        }),
      })
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

  it("rejects unknown desktop capture payloads without media or transcript before creating a meeting", async () => {
    const { POST } = await import("@/app/api/desktop-capture/ingest/route")
    const response = await POST(
      new Request("http://localhost/api/desktop-capture/ingest", {
        method: "POST",
        body: formWith({
          meeting: {
            title: "Missing content",
            startedAt: "2026-07-05T09:00:00.000Z",
          },
        }),
      })
    )

    await expect(response.json()).resolves.toMatchObject({
      error: "Audio/video file or transcript segments are required",
    })
    expect(response.status).toBe(400)
    expect(mocks.createMeeting).not.toHaveBeenCalled()
  })

  it("reuses an existing desktop media asset when a spooled upload retry repeats the capture id", async () => {
    const existingAsset = {
      id: "asset_existing",
      meetingId: "meet_known",
      storageKey: "meetings/known/existing.wav",
      contentType: "audio/wav",
      sizeBytes: 3,
      retention: "audio",
      source: "desktop_capture",
      sourceFileId: "capture_123",
      checksumSha256: "abc123",
      metadata: { captureId: "capture_123" },
      createdAt: "2026-07-05T09:00:00.000Z",
    }
    mocks.findMediaAssetBySourceFile.mockResolvedValue(existingAsset)
    const { POST } = await import("@/app/api/meetings/[id]/upload/route")
    const response = await POST(
      new Request("http://localhost/api/meetings/meet_known/upload", {
        method: "POST",
        body: formWith({
          file: audioFile(),
          captureMetadata: {
            captureId: "capture_123",
            uploadStatus: "retry",
          },
        }),
      }),
      { params: Promise.resolve({ id: "meet_known" }) }
    )

    expect(response.status).toBe(202)
    expect(mocks.storeMeetingObject).not.toHaveBeenCalled()
    expect(mocks.createMediaAsset).not.toHaveBeenCalled()
    expect(mocks.enqueueMeetSumJob).toHaveBeenCalledWith(
      "media.ingest",
      expect.objectContaining({
        assetId: "asset_existing",
        mode: "desktop-media",
      })
    )
  })
})
