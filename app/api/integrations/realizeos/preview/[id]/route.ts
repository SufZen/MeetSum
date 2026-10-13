import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { withAuthz } from "@/lib/auth/authz"
import { createRealizeOSPayload } from "@/lib/integrations/realizeos"

export const GET = withAuthz<{ id: string }>(
  "meeting:read",
  async (_request, ctx, { params }) => {
    const { id } = await params
    const meeting = await ctx.meetings.getMeeting(id)

    if (!meeting) return jsonError("Meeting not found", 404)

    try {
      const payload = createRealizeOSPayload(meeting)

      return NextResponse.json(payload)
    } catch (error) {
      return jsonError(
        error instanceof Error ? error.message : "Unable to build RealizeOS payload",
        400
      )
    }
  }
)
