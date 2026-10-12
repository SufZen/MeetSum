import { NextResponse } from "next/server"
import { randomUUID } from "node:crypto"

import { requireAppAccess } from "@/lib/api/responses"
import {
  DESKTOP_CAPTURE_SOURCE,
  captureIdFromUploadFields,
  ingestDesktopCapture,
  readDesktopUploadFields,
} from "@/lib/capture/desktop-upload"
import {
  parseDesktopJsonField,
  parseDesktopMeetingInput,
} from "@/lib/capture/desktop-ingestion"
import { UploadError, getUploadLimits } from "@/lib/capture/media-validation"
import {
  parseMediaUploadRequest,
  uploadErrorResponse,
  type ParsedMediaUpload,
} from "@/lib/capture/multipart-upload"
import type { MeetingRecord } from "@/lib/meetings/repository"
import { meetingRepository } from "@/lib/meetings/store"
import { createPlatformEvent } from "@/lib/platform/events"

export const runtime = "nodejs"

/**
 * POST /api/desktop-capture/ingest — desktop companion / manual import for a
 * meeting that doesn't exist yet. Media is streamed to
 * `meetings/_incoming/<uuid>/…`; the meeting is created idempotently per
 * desktop `captureId`, so spooled retries never duplicate meetings or jobs.
 */
export async function POST(request: Request) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) {
    return unauthorized
  }

  const limits = getUploadLimits()
  let upload: ParsedMediaUpload

  try {
    upload = await parseMediaUploadRequest(request, {
      maxFileBytes: limits.maxUploadBytes,
      maxFieldBytes: limits.maxFieldBytes,
      async resolveKeyPrefix(fields) {
        const captureId = captureIdFromUploadFields(fields)

        if (captureId) {
          const existingMeeting = await meetingRepository.findMeetingByExternalId(
            DESKTOP_CAPTURE_SOURCE,
            captureId
          )
          const existingAsset = existingMeeting
            ? await meetingRepository.findMediaAssetBySourceFile?.(
                DESKTOP_CAPTURE_SOURCE,
                captureId,
                { meetingId: existingMeeting.id }
              )
            : undefined

          // Already stored for this capture: drain instead of re-uploading.
          if (existingAsset) return null
        }

        return `meetings/_incoming/${randomUUID()}`
      },
    })
  } catch (error) {
    return uploadErrorResponse(error, "Invalid desktop capture payload")
  }

  let parsedMeeting: ReturnType<typeof parseDesktopMeetingInput>
  let captureId: string | undefined

  try {
    try {
      parsedMeeting = parseDesktopMeetingInput(
        parseDesktopJsonField(upload.fields, "meeting")
      )
    } catch (error) {
      throw error instanceof UploadError
        ? error
        : new UploadError(
            error instanceof Error ? error.message : "Invalid meeting payload",
            400
          )
    }

    const { metadata, transcriptSegments } = readDesktopUploadFields(
      upload.fields,
      parsedMeeting.meeting.language
    )

    if (!upload.file && !upload.skippedFile && transcriptSegments.length === 0) {
      throw new UploadError(
        "Audio/video file or transcript segments are required",
        400
      )
    }

    captureId = metadata.captureId
  } catch (error) {
    await upload.cleanup()
    return uploadErrorResponse(error, "Invalid desktop capture payload")
  }

  let meeting: MeetingRecord
  let created: boolean

  try {
    if (captureId) {
      const outcome = await meetingRepository.createMeetingIfAbsent({
        ...parsedMeeting.meeting,
        externalSource: DESKTOP_CAPTURE_SOURCE,
        externalId: captureId,
      })

      meeting = outcome.meeting
      created = outcome.created
    } else {
      meeting = await meetingRepository.createMeeting(parsedMeeting.meeting)
      created = true
    }
  } catch (error) {
    await upload.cleanup()
    return uploadErrorResponse(error, "Unable to create desktop capture meeting")
  }

  try {
    const result = await ingestDesktopCapture({
      meetingId: meeting.id,
      upload,
      language: meeting.language,
      captureSource: "desktop",
      metadataOverrides: { endedAt: parsedMeeting.endedAt },
    })
    const deduplicated = !created || result.deduplicated

    return NextResponse.json(
      {
        meeting,
        asset: result.asset,
        job: result.job,
        deduplicated,
        transcriptSegments: result.transcriptSegments.length,
        captureMetadata: result.captureMetadata,
        event: created
          ? createPlatformEvent("meeting.created", { meetingId: meeting.id })
          : undefined,
      },
      { status: deduplicated ? 200 : 202 }
    )
  } catch (error) {
    // ingestDesktopCapture already deleted the object if no asset row
    // references it. For a meeting created by this request, discard it (with
    // its asset rows) and then delete the stored object as well.
    if (created) {
      const discarded = await meetingRepository
        .discardMeeting(meeting.id)
        .catch(() => false)

      if (discarded) await upload.cleanup()
    }

    return uploadErrorResponse(error, "Invalid desktop capture payload")
  }
}
