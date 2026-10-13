import { NextResponse } from "next/server"

import { auditActor, meetingNotFound } from "@/app/api/_lib/meeting-access"
import { jsonError } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { can, canManageMeeting, withAuthz } from "@/lib/auth/authz"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"
import type { MeetingDetailResponse } from "@/lib/meetings/transcript-wire"
import { withoutWords } from "@/lib/meetings/transcript-wire"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"
import { requestMeetingReindex } from "@/lib/search/index-trigger"
import { deleteMeetingObjects } from "@/lib/storage/object-storage"
import { getLogger } from "@/lib/log"

const log = getLogger({ component: "meetings" })

const MEETING_TITLE_MAX_CHARS = 200

function includesTranscript(request: Request) {
  return (new URL(request.url).searchParams.get("include") ?? "")
    .split(",")
    .map((value) => value.trim())
    .includes("transcript")
}

/**
 * GET /api/meetings/:id — meeting detail without the transcript (read it from
 * `/transcript`), with segment counts, transcript version, duration and the
 * caller's permissions. `?include=transcript` adds the segments without
 * word timings (API / MCP compatibility).
 */
export const GET = withAuthz<{ id: string }>(
  "meeting:read",
  async (request, ctx, { params }) => {
    const { id } = await params
    const includeTranscript = includesTranscript(request)
    const meeting = id
      ? await ctx.meetings.getMeeting(id, { includeTranscript })
      : undefined

    if (!meeting) return meetingNotFound()

    const body: MeetingDetailResponse = {
      meeting: includeTranscript
        ? { ...meeting, transcript: (meeting.transcript ?? []).map(withoutWords) }
        : meeting,
      permissions: {
        canWrite: can(ctx.role, "meeting:write"),
        canManage: canManageMeeting(ctx, meeting),
      },
    }

    return NextResponse.json(body)
  }
)

/** PATCH /api/meetings/:id — rename. Body: `{ title }` (trimmed, 1..200 chars). */
export const PATCH = withAuthz<{ id: string }>(
  "meeting:write",
  async (request, ctx, { params }) => {
    const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.api)

    if (rateLimit.blocked) return rateLimit.blocked

    const { id } = await params
    const body = (await request.json().catch(() => ({}))) as { title?: unknown }

    if (typeof body.title !== "string") return jsonError("title must be a string", 400)

    const title = body.title.normalize("NFC").trim()

    if (!title) return jsonError("title must not be empty", 400)
    if (Array.from(title).length > MEETING_TITLE_MAX_CHARS) {
      return jsonError(`title must be at most ${MEETING_TITLE_MAX_CHARS} characters`, 400)
    }

    const meeting = id
      ? await ctx.meetings.getMeeting(id, { includeTranscript: false })
      : undefined

    if (!meeting) return meetingNotFound()

    const renamed = await ctx.meetings.renameMeeting(id, title)

    await recordAuditLog({
      ...auditActor(ctx),
      action: "meeting.renamed",
      targetType: "meeting",
      targetId: id,
      metadata: { from: meeting.title, to: title },
    })

    await requestMeetingReindex({ workspaceId: ctx.workspace.id, meetingId: id, reason: "renamed" })

    return NextResponse.json({ meeting: renamed })
  }
)

/**
 * DELETE /api/meetings/:id — hard delete (owner or admin; API keys need the
 * admin scope). Rows cascade in one transaction; media, renditions and
 * peaks objects are deleted after the commit, and any that fail are handed
 * to a `storage.delete` job.
 */
export const DELETE = withAuthz<{ id: string }>(
  "meeting:read",
  async (request, ctx, { params }) => {
    const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.api)

    if (rateLimit.blocked) return rateLimit.blocked

    const { id } = await params
    const meeting = id
      ? await ctx.meetings.getMeeting(id, { includeTranscript: false })
      : undefined

    if (!meeting) return meetingNotFound()
    if (!canManageMeeting(ctx, meeting)) {
      return NextResponse.json(
        { error: "Forbidden", permission: "meeting:manage" },
        { status: 403 }
      )
    }

    const deleted = await ctx.meetings.deleteMeeting(id)

    if (!deleted) return meetingNotFound()

    let failedKeys: string[] = []

    if (deleted.storageKeys.length) {
      try {
        const result = await deleteMeetingObjects(deleted.storageKeys)

        failedKeys = result.failed.map((failure) => failure.key)
      } catch (error) {
        log.error({ err: error }, "[meetings] object delete failed; queueing storage.delete")
        failedKeys = [...deleted.storageKeys]
      }
    }

    if (failedKeys.length) {
      try {
        await enqueueMeetSumJob("storage.delete", {
          workspaceId: ctx.workspace.id,
          keys: failedKeys,
        })
      } catch (error) {
        log.error({ err: error }, "[meetings] unable to queue storage.delete")
      }
    }

    await recordAuditLog({
      ...auditActor(ctx),
      action: "meeting.deleted",
      targetType: "meeting",
      targetId: id,
      metadata: {
        title: deleted.title,
        assetCount: deleted.assetCount,
        objectDeleteFailures: failedKeys.length,
      },
    })

    return NextResponse.json({ deleted: true })
  }
)
