import { NextResponse } from "next/server"

import {
  loadVisibleMeeting,
  meetingNotFound,
} from "@/app/api/_lib/meeting-access"
import { jsonError } from "@/lib/api/responses"
import { withAuthz } from "@/lib/auth/authz"

export const PATCH = withAuthz<{ id: string }>(
  "meeting:write",
  async (request, ctx, { params }) => {
    const { id } = await params
    const body = await request.json().catch(() => ({}))

    if (!Array.isArray(body.tags)) {
      return jsonError("tags array is required", 400)
    }

    if (!(await loadVisibleMeeting(ctx, id))) return meetingNotFound()

    try {
      const meeting = await ctx.meetings.updateMeetingTags(
        id,
        body.tags.map(String)
      )

      return NextResponse.json({ meeting })
    } catch (error) {
      return jsonError(
        error instanceof Error ? error.message : "Unable to update tags",
        404
      )
    }
  }
)
