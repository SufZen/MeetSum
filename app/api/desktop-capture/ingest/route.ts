import { NextResponse } from "next/server"
import { randomUUID } from "node:crypto"

import { can, withAuthz, type AuthContext } from "@/lib/auth/authz"
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
import {
  MeetingExternalIdConflictError,
  type MeetingRecord,
} from "@/lib/meetings/repository"
import { createPlatformEvent } from "@/lib/platform/events"
import {
  getAppSettings,
  resolveDefaultMeetingLanguage,
} from "@/lib/settings/app-settings"

export const runtime = "nodejs"

/** Multipart field naming an existing meeting the recording belongs to (M9 D5 offline queue). */
const TARGET_MEETING_FIELD = "targetMeetingId"

const TARGET_MEETING_ID = /^[A-Za-z0-9_-]{1,128}$/

/**
 * The existing meeting a queued recording targets, or undefined when the
 * upload names none. Validated server-side: the meeting must be visible to
 * the caller in the session workspace (`ctx.meetings` is scoped to it, so
 * another workspace's meeting is a 404 like a missing one) and the caller
 * must be allowed to write meetings.
 */
async function loadTargetMeeting(
  ctx: Pick<AuthContext, "meetings" | "role">,
  fields: Record<string, string>
): Promise<MeetingRecord | undefined> {
  const raw = fields[TARGET_MEETING_FIELD]

  if (raw === undefined || raw === "") return undefined
  if (!TARGET_MEETING_ID.test(raw)) throw new UploadError("Meeting not found", 404)

  const meeting = await ctx.meetings.getMeeting(raw)

  if (!meeting) throw new UploadError("Meeting not found", 404)
  if (!can(ctx.role, "meeting:write")) throw new UploadError("Forbidden", 403)

  return meeting
}

/**
 * POST /api/desktop-capture/ingest — desktop companion / manual import for a
 * meeting that doesn't exist yet. Media is streamed to
 * `meetings/_incoming/<uuid>/…`; the meeting is created idempotently per
 * desktop `captureId` within the caller's workspace, so spooled retries never
 * duplicate meetings or jobs.
 *
 * M9 D5: an offline-queued recording made for an existing meeting names it
 * in `targetMeetingId`; the media then attaches to that meeting (deduped by
 * `captureId` on it) and no meeting is ever created.
 */
export const POST = withAuthz("meeting:create", async (request, ctx) => {
  // M9 D5: the PWA offline queue names the workspace a recording was made
  // in; never ingest it into another one (checked before reading the body).
  const recordedIn = request.headers.get("x-meetsum-workspace-id")

  if (recordedIn !== null && recordedIn !== ctx.workspace.id) {
    return NextResponse.json({ error: "workspace_mismatch" }, { status: 409 })
  }

  const limits = getUploadLimits()
  let upload: ParsedMediaUpload
  // Resolved once: from the text fields when the file part arrives (before
  // any byte is stored), else after parsing (transcript-only uploads). A
  // rejected target drains the file and is answered after parsing.
  type TargetOutcome = { meeting?: MeetingRecord; error?: unknown }
  let targetPromise: Promise<TargetOutcome> | undefined
  const targetMeeting = (fields: Record<string, string>) =>
    (targetPromise ??= loadTargetMeeting(ctx, fields).then(
      (meeting): TargetOutcome => ({ meeting }),
      (error: unknown): TargetOutcome => ({ error })
    ))

  try {
    upload = await parseMediaUploadRequest(request, {
      maxFileBytes: limits.maxUploadBytes,
      maxFieldBytes: limits.maxFieldBytes,
      async resolveKeyPrefix(fields) {
        const captureId = captureIdFromUploadFields(fields)
        const { meeting: target, error: targetError } = await targetMeeting(fields)

        if (targetError) return null
        if (target) {
          const existing = captureId
            ? await ctx.meetings.findMediaAssetBySourceFile?.(DESKTOP_CAPTURE_SOURCE, captureId, {
                meetingId: target.id,
              })
            : undefined

          // Already attached to the target meeting: drain instead of re-uploading.
          return existing ? null : `meetings/${target.id}`
        }

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
  let target: MeetingRecord | undefined

  try {
    const outcome = await targetMeeting(upload.fields)

    if (outcome.error) throw outcome.error
    target = outcome.meeting
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

  if (target) {
    try {
      const result = await ingestDesktopCapture({
        meetingId: target.id,
        repository: ctx.meetings,
        workspaceId: ctx.workspace.id,
        upload,
        language: target.language,
        captureSource: "desktop",
        metadataOverrides: { endedAt: parsedMeeting.endedAt },
      })

      return NextResponse.json(
        {
          meeting: target,
          asset: result.asset,
          job: result.job,
          deduplicated: result.deduplicated,
          transcriptSegments: result.transcriptSegments.length,
          captureMetadata: result.captureMetadata,
        },
        { status: result.deduplicated ? 200 : 202 }
      )
    } catch (error) {
      return uploadErrorResponse(error, "Invalid desktop capture payload")
    }
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

    // The captureId belongs to a meeting this caller cannot see: answer with
    // a generic conflict that carries no meeting information.
    if (error instanceof MeetingExternalIdConflictError) {
      return NextResponse.json({ error: "capture_conflict" }, { status: 409 })
    }

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
