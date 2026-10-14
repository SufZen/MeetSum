import { NextResponse } from "next/server"

import {
  auditActor,
  loadVisibleMeeting,
  meetingNotFound,
} from "@/app/api/_lib/meeting-access"
import { recordAuditLog } from "@/lib/audit"
import { withAuthz } from "@/lib/auth/authz"
import { refreshSpeakerSuggestions } from "@/lib/meetings/speakers/suggest"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"

/**
 * POST /api/meetings/:id/speakers/suggest — recompute speaker suggestions
 * ("Suggest again"). Confirmed and rejected speakers are left alone.
 */
export const POST = withAuthz<{ id: string }>(
  "meeting:write",
  async (request, ctx, { params }) => {
    const rateLimit = await rateLimitRequest(request, RATE_LIMIT_PRESETS.api)

    if (rateLimit.blocked) return rateLimit.blocked

    const { id } = await params

    if (!(await loadVisibleMeeting(ctx, id))) return meetingNotFound()

    const suggested = await refreshSpeakerSuggestions(ctx.meetings, id)
    const speakers = await ctx.meetings.listMeetingSpeakers(id)

    await recordAuditLog({
      ...auditActor(ctx),
      action: "meeting.speaker.suggested",
      targetType: "meeting",
      targetId: id,
      metadata: { suggested },
    })

    return NextResponse.json({ suggested, speakers }, { headers: rateLimit.headers })
  }
)
