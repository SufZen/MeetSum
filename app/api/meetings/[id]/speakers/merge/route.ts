import { NextResponse } from "next/server"

import {
  auditActor,
  loadVisibleMeeting,
  meetingNotFound,
} from "@/app/api/_lib/meeting-access"
import { speakerNotFound } from "@/app/api/meetings/[id]/speakers/_lib/speaker-mapping"
import { jsonError } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { withAuthz } from "@/lib/auth/authz"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"
import { requestMeetingReindex } from "@/lib/search/index-trigger"

/**
 * POST /api/meetings/:id/speakers/merge
 * Body: { sourceSpeakerId, targetSpeakerId }. Moves the source speaker's
 * segments to the target (diarization split one person in two) and deletes
 * the source. Segment text and words are untouched.
 */
export const POST = withAuthz<{ id: string }>(
  "meeting:write",
  async (request, ctx, { params }) => {
    const rateLimit = await rateLimitRequest(request, RATE_LIMIT_PRESETS.api)

    if (rateLimit.blocked) return rateLimit.blocked

    const { id } = await params
    const body = (await request.json().catch(() => ({}))) as {
      sourceSpeakerId?: unknown
      targetSpeakerId?: unknown
    }
    const sourceId = typeof body.sourceSpeakerId === "string" ? body.sourceSpeakerId : ""
    const targetId = typeof body.targetSpeakerId === "string" ? body.targetSpeakerId : ""

    if (!sourceId || !targetId) {
      return jsonError("sourceSpeakerId and targetSpeakerId are required", 400)
    }
    if (sourceId === targetId) {
      return jsonError("Cannot merge a speaker into itself", 400)
    }

    if (!(await loadVisibleMeeting(ctx, id))) return meetingNotFound()

    // Child-id IDOR guard: both speakers must belong to this meeting.
    const speakers = await ctx.meetings.listMeetingSpeakers(id)
    const source = speakers.find((speaker) => speaker.id === sourceId)
    const target = speakers.find((speaker) => speaker.id === targetId)

    if (!source || !target) return speakerNotFound()

    const speaker = await ctx.meetings.mergeMeetingSpeakers(id, sourceId, targetId)

    await recordAuditLog({
      ...auditActor(ctx),
      action: "meeting.speaker.merged",
      targetType: "meeting",
      targetId: id,
      metadata: {
        sourceSpeakerId: sourceId,
        sourceLabel: source.label,
        targetSpeakerId: targetId,
        targetLabel: target.label,
      },
    })

    await requestMeetingReindex({ workspaceId: ctx.workspace.id, meetingId: id, reason: "speakers" })

    return NextResponse.json({ speaker }, { headers: rateLimit.headers })
  }
)
