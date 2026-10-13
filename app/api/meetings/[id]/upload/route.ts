import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { withAuthz } from "@/lib/auth/authz"
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
import { createPlatformEvent } from "@/lib/platform/events"

export const runtime = "nodejs"

export const POST = withAuthz<{ id: string }>(
  "meeting:create",
  async (request, ctx, { params }) => {
    const { id } = await params
    // Invisible / other-workspace meetings answer 404 before any byte is read.
    const meeting = await ctx.meetings.getMeeting(id)

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
            const existing = await ctx.meetings.findMediaAssetBySourceFile?.(
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
        repository: ctx.meetings,
        workspaceId: ctx.workspace.id,
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
          event: createPlatformEvent(
            "meeting.created",
            { meetingId: id },
            { workspaceId: ctx.workspace.id }
          ),
        },
        { status: 202 }
      )
    } catch (error) {
      return uploadErrorResponse(error, "Invalid upload payload")
    }
  }
)
