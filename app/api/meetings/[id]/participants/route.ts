import { NextResponse } from "next/server"

import {
  loadVisibleMeeting,
  meetingNotFound,
} from "@/app/api/_lib/meeting-access"
import { jsonError } from "@/lib/api/responses"
import { withAuthz } from "@/lib/auth/authz"

export const GET = withAuthz<{ id: string }>(
  "meeting:read",
  async (_request, ctx, { params }) => {
    const { id } = await params

    if (!(await loadVisibleMeeting(ctx, id))) return meetingNotFound()

    try {
      const participants = await ctx.meetings.listMeetingParticipants(id)

      return NextResponse.json({ participants })
    } catch (error) {
      return jsonError(
        error instanceof Error ? error.message : "Unable to load participants",
        404
      )
    }
  }
)
