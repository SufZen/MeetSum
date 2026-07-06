import { enqueueMeetSumJob } from "@/lib/jobs/queue"
import { meetingRepository } from "@/lib/meetings/store"
import { storeMeetingObject } from "@/lib/storage/object-storage"
import { createHash } from "node:crypto"
import {
  buildDesktopCaptureIngestionPlan,
  normalizeDesktopCaptureMetadata,
  normalizeDesktopTranscriptSegments,
  parseDesktopJsonField,
  recordDesktopTranscriptionRun,
  type DesktopCaptureMetadata,
} from "@/lib/capture/desktop-ingestion"

export async function ingestDesktopCaptureForMeeting(options: {
  meetingId: string
  formData: FormData
  language?: string
  captureSource?: "desktop" | "upload"
}) {
  const file = options.formData.get("file")
  const transcriptPayload = parseDesktopJsonField(options.formData, "transcript")
  const metadata = normalizeDesktopCaptureMetadata(
    parseDesktopJsonField(options.formData, "captureMetadata")
  )
  const transcriptSegments = normalizeDesktopTranscriptSegments(
    transcriptPayload,
    options.language ?? "he"
  )
  const hasFile = file instanceof File
  const isDesktopCapture =
    options.captureSource === "desktop" ||
    transcriptSegments.length > 0 ||
    Object.keys(metadata).length > 0

  if (!hasFile && transcriptSegments.length === 0) {
    throw new Error("Audio/video file or transcript segments are required")
  }

  let asset:
    | Awaited<ReturnType<typeof meetingRepository.createMediaAsset>>
    | undefined
  let stored:
    | Awaited<ReturnType<typeof storeMeetingObject>>
    | undefined

  if (hasFile) {
    const captureId = metadata.captureId
    const existingAsset = isDesktopCapture && captureId
      ? await meetingRepository.findMediaAssetBySourceFile?.(
          "desktop_capture",
          captureId
        )
      : undefined

    if (existingAsset) {
      asset = existingAsset
    } else {
      const contentType = file.type || "application/octet-stream"
      const bytes = Buffer.from(await file.arrayBuffer())
      const checksumSha256 = createHash("sha256").update(bytes).digest("hex")

      stored = await storeMeetingObject({
        meetingId: options.meetingId,
        filename: file.name,
        contentType,
        bytes,
      })
      asset = await meetingRepository.createMediaAsset({
        meetingId: options.meetingId,
        storageKey: stored.key,
        filename: file.name,
        contentType,
        sizeBytes: stored.sizeBytes,
        retention: contentType.startsWith("video/") ? "video" : "audio",
        source: isDesktopCapture ? "desktop_capture" : undefined,
        sourceFileId: isDesktopCapture ? captureId : undefined,
        checksumSha256: isDesktopCapture ? checksumSha256 : undefined,
        metadata:
          isDesktopCapture && Object.keys(metadata).length
            ? metadata
            : undefined,
      })
    }
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

  const plan = buildDesktopCaptureIngestionPlan({
    hasFile,
    transcriptSegments: transcriptSegments.length,
  })
  const jobPayload = {
    meetingId: options.meetingId,
    assetId: asset?.id,
    storageKey: stored?.key,
    bucket: stored?.bucket,
    ...(isDesktopCapture
      ? {
          mode: plan.mode,
          source: "desktop-capture",
          captureMetadata: metadata,
        }
      : {}),
  }
  const job = await enqueueMeetSumJob(plan.jobName, jobPayload)

  return {
    asset,
    job,
    transcriptSegments,
    captureMetadata: metadata satisfies DesktopCaptureMetadata,
    plan,
  }
}
