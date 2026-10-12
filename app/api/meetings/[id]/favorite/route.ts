import { NextResponse } from "next/server"

import {
  loadVisibleMeeting,
  meetingNotFound,
} from "@/app/api/_lib/meeting-access"
import { jsonError } from "@/lib/api/responses"
import { withAuthz } from "@/lib/auth/authz"

/** PATCH /api/meetings/:id/favorite — per-user favorite (signed-in users only). */
export const PATCH = withAuthz<{ id: string }>(
  "meeting:read",
  async (request, ctx, { params }) => {
    const { id } = await params
    const body = await request.json().catch(() => ({}))

    if (typeof body.favorite !== "boolean") {
      return jsonError("favorite boolean is required", 400)
    }

    if (ctx.principal !== "user") {
      return jsonError("Favorites are per user; API keys cannot set them", 400)
    }

    const meeting = await loadVisibleMeeting(ctx, id)

    if (!meeting) return meetingNotFound()

    try {
      const updated = await ctx.meetings.updateMeetingFavorite(
        id,
        body.favorite
      )

      return NextResponse.json({ meeting: updated })
    } catch (error) {
      return jsonError(
        error instanceof Error ? error.message : "Unable to update favorite",
        404
      )
    }
  }
)
