import { UnrecoverableError } from "bullmq"

import {
  UploadTooLargeError,
  getUploadLimits,
  retentionForContentType,
} from "@/lib/capture/media-validation"
import { teamsCaptureAdapter } from "@/lib/capture/teams"
import {
  CaptureConfigError,
  RecordingDownloadError,
  type CaptureAdapter,
  type CaptureEvent,
} from "@/lib/capture/types"
import { zoomCaptureAdapter } from "@/lib/capture/zoom"
import { getSystemMeetingRepository } from "@/lib/meetings/store"
import {
  deleteMeetingObject,
  storeMeetingObjectStream,
} from "@/lib/storage/object-storage"

export type PlatformRecordingImport = {
  assetId: string
  storageKey: string
  contentType: string
  sizeBytes: number
  reused: boolean
}

const adapters: Record<"zoom" | "teams", CaptureAdapter> = {
  zoom: zoomCaptureAdapter,
  teams: teamsCaptureAdapter,
}

/** HTTP statuses that will never succeed on retry. */
const PERMANENT_STATUSES = new Set([401, 403, 404, 410])

/**
 * Classifies an import failure for BullMQ: config problems, auth/missing
 * recordings (401/403/404/410) and oversized files are permanent
 * (UnrecoverableError); 408/429/5xx and network errors stay retryable.
 */
export function classifyRecordingImportError(error: unknown): Error {
  if (error instanceof UnrecoverableError) return error

  if (error instanceof CaptureConfigError || error instanceof UploadTooLargeError) {
    return new UnrecoverableError(error.message)
  }

  if (error instanceof RecordingDownloadError) {
    return PERMANENT_STATUSES.has(error.status)
      ? new UnrecoverableError(error.message)
      : new Error(error.message)
  }

  return error instanceof Error ? error : new Error(String(error))
}

/**
 * Downloads a Zoom/Teams cloud recording into object storage and links it as
 * a media asset of the meeting. Idempotent per `(meetingId, platform,
 * externalId)`: an existing scoped asset is reused without downloading.
 * The recording is streamed (never buffered whole) and capped at
 * MEETSUM_MAX_RECORDING_BYTES.
 */
export async function importPlatformRecording(input: {
  meetingId: string
  workspaceId: string
  platform: "zoom" | "teams"
  captureEvent: CaptureEvent
}): Promise<PlatformRecordingImport> {
  const { meetingId, platform, captureEvent } = input
  const meetingRepository = getSystemMeetingRepository(input.workspaceId)
  const adapter = adapters[platform]

  if (!adapter) {
    throw new UnrecoverableError(`Unsupported capture platform: ${String(platform)}`)
  }

  if (!captureEvent?.externalId) {
    throw new UnrecoverableError(`${platform} capture event has no externalId`)
  }

  const existing = await meetingRepository.findMediaAssetBySourceFile?.(
    platform,
    captureEvent.externalId,
    { meetingId }
  )

  if (existing) {
    return {
      assetId: existing.id,
      storageKey: existing.storageKey,
      contentType: existing.contentType,
      sizeBytes: existing.sizeBytes,
      reused: true,
    }
  }

  const { maxRecordingBytes } = getUploadLimits()
  let storedKey: string | undefined

  try {
    const download = await adapter.downloadRecording(captureEvent)

    if (download.sizeBytes !== undefined && download.sizeBytes > maxRecordingBytes) {
      const body = download.body as Partial<ReadableStream & { destroy: () => void }>

      if (typeof body.cancel === "function") {
        await body.cancel().catch(() => {})
      } else {
        body.destroy?.()
      }
      throw new UploadTooLargeError(maxRecordingBytes)
    }

    const stored = await storeMeetingObjectStream({
      keyPrefix: `meetings/${meetingId}`,
      filename: download.filename,
      contentType: download.contentType,
      body: download.body,
      maxBytes: maxRecordingBytes,
    })

    storedKey = stored.key

    const asset = await meetingRepository.createMediaAsset({
      meetingId,
      storageKey: stored.key,
      filename: download.filename,
      contentType: download.contentType,
      sizeBytes: stored.sizeBytes,
      retention: retentionForContentType(download.contentType),
      source: platform,
      sourceFileId: captureEvent.externalId,
      checksumSha256: stored.checksumSha256,
      metadata: {
        platform,
        externalId: captureEvent.externalId,
        ...pickRecordingMetadata(captureEvent.metadata),
      },
    })

    return {
      assetId: asset.id,
      storageKey: asset.storageKey,
      contentType: asset.contentType,
      sizeBytes: asset.sizeBytes,
      reused: false,
    }
  } catch (error) {
    if (storedKey) {
      await deleteMeetingObject(storedKey).catch(() => {})
    }

    throw classifyRecordingImportError(error)
  }
}

const SAFE_METADATA_KEYS = [
  "zoomMeetingId",
  "recordingFileId",
  "recordingType",
  "fileType",
  "duration",
  "subscriptionId",
]

function pickRecordingMetadata(metadata: Record<string, unknown> = {}) {
  return Object.fromEntries(
    SAFE_METADATA_KEYS.filter((key) => metadata[key] !== undefined).map((key) => [
      key,
      metadata[key],
    ])
  )
}
