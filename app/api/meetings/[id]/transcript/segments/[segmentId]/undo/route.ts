import { NextResponse } from "next/server"

import { auditActor } from "@/app/api/_lib/meeting-access"
import {
  editActorUserId,
  mutationResponse,
  parseRevision,
  transcriptErrorResponse,
} from "@/app/api/meetings/[id]/transcript/_lib/transcript-route"
import { jsonError } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { withAuthz } from "@/lib/auth/authz"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"
import { requestMeetingReindex } from "@/lib/search/index-trigger"

/**
 * POST /api/meetings/:id/transcript/segments/:segmentId/undo
 * Body: { revision } — undoes the segment's latest non-reverted edit as a
 * whole (M9 B5): every segment of its edit group (a whole-turn speaker
 * change) is restored in one transaction, and `segments` lists them all.
 * 409 `{error:"nothing_to_undo"}`, or `{error:"conflict", segment}` when any
 * segment of the group changed since (nothing is reverted).
 */
export const POST = withAuthz<{ id: string; segmentId: string }>(
  "meeting:write",
  async (request, ctx, { params }) => {
    const rateLimit = await rateLimitRequest(request, RATE_LIMIT_PRESETS.api)

    if (rateLimit.blocked) return rateLimit.blocked

    const { id, segmentId } = await params
    const body = (await request.json().catch(() => ({}))) as { revision?: unknown }
    const revision = parseRevision(body?.revision)

    if (revision === undefined) return jsonError("revision must be a non-negative integer", 400)

    try {
      const result = await ctx.meetings.undoTranscriptSegment(id, segmentId, {
        expectedRevision: revision,
        actorUserId: editActorUserId(ctx),
      })

      await recordAuditLog({
        ...auditActor(ctx),
        action: "meeting.transcript.reverted",
        targetType: "meeting",
        targetId: id,
        metadata: {
          segmentId,
          revision: result.segment.revision ?? 0,
          segmentCount: result.segments?.length ?? 1,
        },
      })

      await requestMeetingReindex({ workspaceId: ctx.workspace.id, meetingId: id, reason: "transcript.edited" })

      return NextResponse.json(mutationResponse(result))
    } catch (error) {
      return transcriptErrorResponse(error)
    }
  }
)
