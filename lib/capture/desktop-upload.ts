import { enqueueMeetSumJob } from "@/lib/jobs/queue"
import type { JobRecord, MediaAsset } from "@/lib/meetings/repository"
import { meetingRepository } from "@/lib/meetings/store"
import {
  buildDesktopCaptureIngestionPlan,
  normalizeDesktopCaptureMetadata,
  normalizeDesktopTranscriptSegments,
  parseDesktopJsonField,
  recordDesktopTranscriptionRun,
  type DesktopCaptureMetadata,
  type DesktopIngestionPlan,
} from "@/lib/capture/desktop-ingestion"
import {
  UploadError,
  retentionForContentType,
} from "@/lib/capture/media-validation"
import type { ParsedMediaUpload } from "@/lib/capture/multipart-upload"

export const DESKTOP_CAPTURE_SOURCE = "desktop_capture"

export type DesktopCaptureIngestResult = {
  asset?: MediaAsset
  job: JobRecord
  transcriptSegments: ReturnType<typeof normalizeDesktopTranscriptSegments>
  captureMetadata: DesktopCaptureMetadata
  plan: DesktopIngestionPlan
  deduplicated: boolean
}

function asValidationError(error: unknown): never {
  if (error instanceof UploadError) throw error
  throw new UploadError(
    error instanceof Error ? error.message : "Invalid upload payload",
    400
  )
}

/** Reads the capture metadata + transcript fields of a parsed upload (400 on bad JSON). */
export function readDesktopUploadFields(
  fields: Record<string, string>,
  language = "he"
) {
  try {
    return {
      metadata: normalizeDesktopCaptureMetadata(
        parseDesktopJsonField(fields, "captureMetadata")
      ),
      transcriptSegments: normalizeDesktopTranscriptSegments(
        parseDesktopJsonField(fields, "transcript"),
        language
      ),
    }
  } catch (error) {
    return asValidationError(error)
  }
}

/** Best-effort captureId lookup used while the upload is still streaming. */
export function captureIdFromUploadFields(
  fields: Record<string, string>
): string | undefined {
  try {
    const raw = fields.captureMetadata

    return raw
      ? normalizeDesktopCaptureMetadata(JSON.parse(raw)).captureId
      : undefined
  } catch {
    return undefined
  }
}

/** Finds a previous non-failed job for the same capture asset (idempotent retries). */
async function findReusableJob(meetingId: string, assetId: string) {
  const jobs = await meetingRepository.listJobs({ meetingId })

  return jobs.find(
    (job) => job.status !== "failed" && job.payload?.assetId === assetId
  )
}

/**
 * Ingests an already-streamed desktop/manual upload for a known meeting.
 * The media bytes were stored by `parseMediaUploadRequest`; this only links
 * the stored object, persists local transcripts and enqueues processing.
 *
 * Idempotent per `(meetingId, captureId)`: a retry reuses the stored asset
 * (deleting the duplicate upload) and the existing non-failed job.
 */
export async function ingestDesktopCapture(options: {
  meetingId: string
  upload: ParsedMediaUpload
  language?: string
  captureSource?: "desktop" | "upload"
  metadataOverrides?: Partial<DesktopCaptureMetadata>
}): Promise<DesktopCaptureIngestResult> {
  const { upload } = options
  const parsed = readDesktopUploadFields(upload.fields, options.language ?? "he")
  const metadata: DesktopCaptureMetadata = Object.fromEntries(
    Object.entries({ ...parsed.metadata, ...options.metadataOverrides }).filter(
      ([, value]) => value !== undefined
    )
  )
  const transcriptSegments = parsed.transcriptSegments
  const hasFile = Boolean(upload.file || upload.skippedFile)
  const isDesktopCapture =
    options.captureSource === "desktop" ||
    transcriptSegments.length > 0 ||
    Object.keys(metadata).length > 0
  const captureId = isDesktopCapture ? metadata.captureId : undefined

  if (!hasFile && transcriptSegments.length === 0) {
    await upload.cleanup()
    throw new UploadError("Audio/video file or transcript segments are required", 400)
  }

  const plan = buildDesktopCaptureIngestionPlan({
    hasFile,
    transcriptSegments: transcriptSegments.length,
  })
  let asset: MediaAsset | undefined
  let assetPersisted = false

  try {
    if (hasFile && captureId) {
      asset = await meetingRepository.findMediaAssetBySourceFile?.(
        DESKTOP_CAPTURE_SOURCE,
        captureId,
        { meetingId: options.meetingId }
      )

      if (asset) {
        assetPersisted = true
        // The media for this capture is already stored: drop the re-upload.
        await upload.cleanup()

        const existingJob = await findReusableJob(options.meetingId, asset.id)

        if (existingJob) {
          return {
            asset,
            job: existingJob,
            transcriptSegments,
            captureMetadata: metadata,
            plan,
            deduplicated: true,
          }
        }
      }
    }

    if (!asset && upload.file) {
      const file = upload.file

      asset = await meetingRepository.createMediaAsset({
        meetingId: options.meetingId,
        storageKey: file.storageKey,
        filename: file.filename,
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
        retention: retentionForContentType(file.contentType),
        source: isDesktopCapture ? DESKTOP_CAPTURE_SOURCE : undefined,
        sourceFileId: captureId,
        checksumSha256: file.checksumSha256,
        metadata:
          isDesktopCapture && Object.keys(metadata).length ? metadata : undefined,
      })
      assetPersisted = true
    }

    if (hasFile && !asset && transcriptSegments.length === 0) {
      throw new UploadError(
        "The uploaded media was skipped but no stored asset exists for this capture",
        409
      )
    }

    if (transcriptSegments.length > 0) {
      await meetingRepository.replaceTranscriptSegments(
        options.meetingId,
        transcriptSegments
      )
      await recordDesktopTranscriptionRun({
        meetingId: options.meetingId,
        segmentCount: transcriptSegments.length,
        metadata,
      })
    }

    const job = await enqueueMeetSumJob(plan.jobName, {
      meetingId: options.meetingId,
      assetId: asset?.id,
      storageKey: asset?.storageKey,
      bucket: upload.file && asset?.storageKey === upload.file.storageKey
        ? upload.file.bucket
        : undefined,
      ...(isDesktopCapture
        ? {
            mode: plan.mode,
            source: "desktop-capture",
            captureMetadata: metadata,
          }
        : {}),
    })

    return {
      asset,
      job,
      transcriptSegments,
      captureMetadata: metadata,
      plan,
      deduplicated: false,
    }
  } catch (error) {
    // Once an asset row references the object, keep the object so a retry
    // can reuse it; otherwise the stored upload is orphaned — delete it.
    if (!assetPersisted) {
      await upload.cleanup()
    }
    throw error
  }
}
