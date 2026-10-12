import { Readable } from "node:stream"
import { UnrecoverableError } from "bullmq"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  findMediaAssetBySourceFile: vi.fn(),
  createMediaAsset: vi.fn(),
  storeMeetingObjectStream: vi.fn(),
  deleteMeetingObject: vi.fn(),
  zoomDownload: vi.fn(),
  teamsDownload: vi.fn(),
}))

vi.mock("@/lib/meetings/store", () => ({
  meetingRepository: {
    findMediaAssetBySourceFile: mocks.findMediaAssetBySourceFile,
    createMediaAsset: mocks.createMediaAsset,
  },
}))

vi.mock("@/lib/storage/object-storage", () => ({
  storeMeetingObjectStream: mocks.storeMeetingObjectStream,
  deleteMeetingObject: mocks.deleteMeetingObject,
}))

vi.mock("@/lib/capture/zoom", () => ({
  zoomCaptureAdapter: { platform: "zoom", downloadRecording: mocks.zoomDownload },
}))

vi.mock("@/lib/capture/teams", () => ({
  teamsCaptureAdapter: { platform: "teams", downloadRecording: mocks.teamsDownload },
}))

import {
  classifyRecordingImportError,
  importPlatformRecording,
} from "@/lib/capture/recording-import"
import { UploadTooLargeError } from "@/lib/capture/media-validation"
import { CaptureConfigError, RecordingDownloadError } from "@/lib/capture/types"
import type { CaptureEvent } from "@/lib/capture/types"

const zoomEvent: CaptureEvent = {
  platform: "zoom",
  eventType: "recording.available",
  externalId: "zoom-uuid-1",
  title: "Weekly",
  startedAt: "2026-05-29T10:00:00Z",
  participants: [],
  recordingUrl: "https://zoom.us/rec/download/a.m4a",
  recordingMimeType: "audio/mp4",
  metadata: { recordingType: "audio_only", fileType: "M4A", secret: "nope" },
}

describe("importPlatformRecording", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.findMediaAssetBySourceFile.mockResolvedValue(undefined)
    mocks.zoomDownload.mockResolvedValue({
      body: Readable.from([Buffer.from("audio")]),
      filename: "zoom-zoom-uuid-1.m4a",
      contentType: "audio/mp4",
      sizeBytes: 5,
    })
    mocks.storeMeetingObjectStream.mockImplementation(
      async (input: { keyPrefix: string; filename: string; contentType: string }) => ({
        bucket: "meeting-media",
        key: `${input.keyPrefix}/stored-${input.filename}`,
        contentType: input.contentType,
        sizeBytes: 5,
        checksumSha256: "sha",
      })
    )
    mocks.createMediaAsset.mockImplementation(async (input: Record<string, unknown>) => ({
      id: "asset_zoom",
      createdAt: "2026-05-29T11:00:00Z",
      ...input,
    }))
    mocks.deleteMeetingObject.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("streams the recording into storage and creates a scoped platform asset", async () => {
    vi.stubEnv("MEETSUM_MAX_RECORDING_BYTES", "1000")

    const result = await importPlatformRecording({
      meetingId: "meet_1",
      platform: "zoom",
      captureEvent: zoomEvent,
    })

    expect(result).toEqual({
      assetId: "asset_zoom",
      storageKey: "meetings/meet_1/stored-zoom-zoom-uuid-1.m4a",
      contentType: "audio/mp4",
      sizeBytes: 5,
      reused: false,
    })
    expect(mocks.findMediaAssetBySourceFile).toHaveBeenCalledWith(
      "zoom",
      "zoom-uuid-1",
      { meetingId: "meet_1" }
    )
    expect(mocks.storeMeetingObjectStream).toHaveBeenCalledWith(
      expect.objectContaining({
        keyPrefix: "meetings/meet_1",
        contentType: "audio/mp4",
        maxBytes: 1000,
      })
    )
    expect(mocks.createMediaAsset).toHaveBeenCalledWith({
      meetingId: "meet_1",
      storageKey: "meetings/meet_1/stored-zoom-zoom-uuid-1.m4a",
      filename: "zoom-zoom-uuid-1.m4a",
      contentType: "audio/mp4",
      sizeBytes: 5,
      retention: "audio",
      source: "zoom",
      sourceFileId: "zoom-uuid-1",
      checksumSha256: "sha",
      metadata: {
        platform: "zoom",
        externalId: "zoom-uuid-1",
        recordingType: "audio_only",
        fileType: "M4A",
      },
    })
  })

  it("reuses an existing scoped asset without downloading", async () => {
    mocks.findMediaAssetBySourceFile.mockResolvedValue({
      id: "asset_existing",
      meetingId: "meet_1",
      storageKey: "meetings/meet_1/existing.m4a",
      contentType: "audio/mp4",
      sizeBytes: 42,
      retention: "audio",
      createdAt: "2026-05-29T11:00:00Z",
    })

    const result = await importPlatformRecording({
      meetingId: "meet_1",
      platform: "zoom",
      captureEvent: zoomEvent,
    })

    expect(result).toMatchObject({ assetId: "asset_existing", reused: true })
    expect(mocks.zoomDownload).not.toHaveBeenCalled()
    expect(mocks.storeMeetingObjectStream).not.toHaveBeenCalled()
  })

  it("routes Teams events to the Teams adapter with video retention", async () => {
    mocks.teamsDownload.mockResolvedValue({
      body: Readable.from([Buffer.from("video")]),
      filename: "teams-r1.mp4",
      contentType: "video/mp4",
    })

    await importPlatformRecording({
      meetingId: "meet_2",
      platform: "teams",
      captureEvent: { ...zoomEvent, platform: "teams", externalId: "r1" },
    })

    expect(mocks.teamsDownload).toHaveBeenCalled()
    expect(mocks.createMediaAsset).toHaveBeenCalledWith(
      expect.objectContaining({ source: "teams", sourceFileId: "r1", retention: "video" })
    )
  })

  it("deletes the stored object when the asset row cannot be created", async () => {
    mocks.createMediaAsset.mockRejectedValue(new Error("db down"))

    await expect(
      importPlatformRecording({ meetingId: "meet_1", platform: "zoom", captureEvent: zoomEvent })
    ).rejects.toThrow("db down")
    expect(mocks.deleteMeetingObject).toHaveBeenCalledWith(
      "meetings/meet_1/stored-zoom-zoom-uuid-1.m4a"
    )
  })

  it.each([401, 403, 404, 410])("treats HTTP %i as permanent", async (status) => {
    mocks.zoomDownload.mockRejectedValue(new RecordingDownloadError("zoom", status))

    const error = await importPlatformRecording({
      meetingId: "meet_1",
      platform: "zoom",
      captureEvent: zoomEvent,
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(UnrecoverableError)
  })

  it.each([408, 429, 500, 503])("keeps HTTP %i retryable", async (status) => {
    mocks.zoomDownload.mockRejectedValue(new RecordingDownloadError("zoom", status))

    const error = await importPlatformRecording({
      meetingId: "meet_1",
      platform: "zoom",
      captureEvent: zoomEvent,
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(UnrecoverableError)
  })

  it("keeps network errors retryable", async () => {
    mocks.zoomDownload.mockRejectedValue(new TypeError("fetch failed"))

    const error = await importPlatformRecording({
      meetingId: "meet_1",
      platform: "zoom",
      captureEvent: zoomEvent,
    }).catch((caught: unknown) => caught)

    expect(error).not.toBeInstanceOf(UnrecoverableError)
    expect((error as Error).message).toBe("fetch failed")
  })

  it("treats missing credentials as permanent", async () => {
    mocks.zoomDownload.mockRejectedValue(new CaptureConfigError("missing ZOOM_CLIENT_ID"))

    await expect(
      importPlatformRecording({ meetingId: "meet_1", platform: "zoom", captureEvent: zoomEvent })
    ).rejects.toBeInstanceOf(UnrecoverableError)
  })

  it("treats recordings over the limit as permanent, before or during streaming", async () => {
    vi.stubEnv("MEETSUM_MAX_RECORDING_BYTES", "4")

    await expect(
      importPlatformRecording({ meetingId: "meet_1", platform: "zoom", captureEvent: zoomEvent })
    ).rejects.toBeInstanceOf(UnrecoverableError)
    expect(mocks.storeMeetingObjectStream).not.toHaveBeenCalled()

    vi.stubEnv("MEETSUM_MAX_RECORDING_BYTES", "1000")
    mocks.storeMeetingObjectStream.mockRejectedValue(new UploadTooLargeError(1000))

    await expect(
      importPlatformRecording({ meetingId: "meet_1", platform: "zoom", captureEvent: zoomEvent })
    ).rejects.toBeInstanceOf(UnrecoverableError)
  })

  it("classifies unknown errors as retryable errors", () => {
    expect(classifyRecordingImportError("boom")).toBeInstanceOf(Error)
    expect(classifyRecordingImportError("boom")).not.toBeInstanceOf(UnrecoverableError)
  })
})
