import { NextResponse } from "next/server"
import { randomUUID } from "node:crypto"

import { withAuthz } from "@/lib/auth/authz"
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
import { createPlatformEvent } from "@/lib/platform/events"
import {
  getAppSettings,
  resolveDefaultMeetingLanguage,
} from "@/lib/settings/app-settings"

export const runtime = "nodejs"

/**
 * POST /api/desktop-capture/ingest — desktop companion / manual import for a
 * meeting that doesn't exist yet. Media is streamed to
 * `meetings/_incoming/<uuid>/…`; the meeting is created idempotently per
 * desktop `captureId` within the caller's workspace, so spooled retries never
 * duplicate meetings or jobs.
 */
export const POST = withAuthz("meeting:create", async (request, ctx) => {
  const limits = getUploadLimits()
  let upload: ParsedMediaUpload

  try {
    upload = await parseMediaUploadRequest(request, {
      maxFileBytes: limits.maxUploadBytes,
      maxFieldBytes: limits.maxFieldBytes,
      async resolveKeyPrefix(fields) {
        const captureId = captureIdFromUploadFields(fields)

        if (captureId) {
          const existingMeeting = await ctx.meetings.findMeetingByExternalId(
            DESKTOP_CAPTURE_SOURCE,
            captureId
          )
          const existingAsset = existingMeeting
            ? await ctx.meetings.findMediaAssetBySourceFile?.(
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
  let settings: Awaited<ReturnType<typeof getAppSettings>>

  try {
    settings = await getAppSettings(ctx.workspace.id)

    try {
      parsedMeeting = parseDesktopMeetingInput(
        parseDesktopJsonField(upload.fields, "meeting"),
        { defaultLanguage: resolveDefaultMeetingLanguage(settings) }
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
  const meetingInput = {
    ...parsedMeeting.meeting,
    ownerUserId: ctx.user?.id ?? ctx.apiKey?.createdByUserId,
    visibility: settings.defaultMeetingVisibility,
  }

  try {
    if (captureId) {
      const outcome = await ctx.meetings.createMeetingIfAbsent({
        ...meetingInput,
        externalSource: DESKTOP_CAPTURE_SOURCE,
        externalId: captureId,
      })

      meeting = outcome.meeting
      created = outcome.created
    } else {
      meeting = await ctx.meetings.createMeeting(meetingInput)
      created = true
    }
  } catch (error) {
    await upload.cleanup()
    return uploadErrorResponse(error, "Unable to create desktop capture meeting")
  }

  try {
    const result = await ingestDesktopCapture({
      meetingId: meeting.id,
      repository: ctx.meetings,
      workspaceId: ctx.workspace.id,
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
          ? createPlatformEvent(
              "meeting.created",
              { meetingId: meeting.id },
              { workspaceId: ctx.workspace.id }
            )
          : undefined,
      },
      { status: deduplicated ? 200 : 202 }
    )
  } catch (error) {
    // ingestDesktopCapture already deleted the object if no asset row
    // references it. For a meeting created by this request, discard it (with
    // its asset rows) and then delete the stored object as well.
    if (created) {
      const discarded = await ctx.meetings
        .discardMeeting(meeting.id)
        .catch(() => false)

      if (discarded) await upload.cleanup()
    }

    return uploadErrorResponse(error, "Invalid desktop capture payload")
  }
})
