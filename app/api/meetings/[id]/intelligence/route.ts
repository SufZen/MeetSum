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
    const meeting = await loadVisibleMeeting(ctx, id)

    if (!meeting) return meetingNotFound()

    const intelligence =
      (await ctx.meetings.getMeetingIntelligence(id)) ?? meeting.intelligence

    if (!intelligence) {
      return jsonError("Meeting intelligence has not been generated", 404)
    }

    return NextResponse.json({ intelligence })
  }
)
