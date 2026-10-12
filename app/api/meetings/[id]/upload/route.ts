import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import {
  DESKTOP_CAPTURE_SOURCE,
  captureIdFromUploadFields,
  ingestDesktopCapture,
} from "@/lib/capture/desktop-upload"
import { getUploadLimits } from "@/lib/capture/media-validation"
import {
  parseMediaUploadRequest,
  uploadErrorResponse,
} from "@/lib/capture/multipart-upload"
import { meetingRepository } from "@/lib/meetings/store"
import { createPlatformEvent } from "@/lib/platform/events"

export const runtime = "nodejs"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) {
    return unauthorized
  }

  const { id } = await params
  const meeting = await meetingRepository.getMeeting(id)

  if (!meeting) {
    return jsonError("Meeting not found", 404)
  }

  const limits = getUploadLimits()

  try {
    const upload = await parseMediaUploadRequest(request, {
      maxFileBytes: limits.maxUploadBytes,
      maxFieldBytes: limits.maxFieldBytes,
      async resolveKeyPrefix(fields) {
        const captureId = captureIdFromUploadFields(fields)

        if (captureId) {
          const existing = await meetingRepository.findMediaAssetBySourceFile?.(
            DESKTOP_CAPTURE_SOURCE,
            captureId,
            { meetingId: id }
          )

          // Retry of an already-stored capture: skip re-uploading the bytes.
          if (existing) return null
        }

        return `meetings/${id}`
      },
    })
    const result = await ingestDesktopCapture({
      meetingId: id,
      upload,
      language: meeting.language,
    })

    return NextResponse.json(
      {
        asset: result.asset,
        job: result.job,
        deduplicated: result.deduplicated,
        transcriptSegments: result.transcriptSegments.length,
        captureMetadata: result.captureMetadata,
        event: createPlatformEvent("meeting.created", { meetingId: id }),
      },
      { status: 202 }
    )
  } catch (error) {
    return uploadErrorResponse(error, "Invalid upload payload")
  }
}
