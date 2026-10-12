import { NextResponse } from "next/server"

import {
  loadVisibleMeeting,
  meetingNotFound,
} from "@/app/api/_lib/meeting-access"
import { jsonError } from "@/lib/api/responses"
import { withAuthz } from "@/lib/auth/authz"

export const POST = withAuthz<{ id: string }>(
  "meeting:write",
  async (request, ctx, { params }) => {
    const { id } = await params
    const body = await request.json().catch(() => ({}))

    if (!body.speakerLabel || !body.participantId) {
      return jsonError("speakerLabel and participantId are required", 400)
    }

    if (!(await loadVisibleMeeting(ctx, id))) return meetingNotFound()

    try {
      const participant = await ctx.meetings.assignSpeakerToParticipant(
        id,
        String(body.speakerLabel),
        String(body.participantId)
      )

      return NextResponse.json({ participant })
    } catch (error) {
      return jsonError(
        error instanceof Error ? error.message : "Unable to assign speaker",
        400
      )
    }
  }
)
