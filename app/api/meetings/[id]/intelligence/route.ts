import { NextResponse } from "next/server"

import {
  loadVisibleMeeting,
  meetingNotFound,
} from "@/app/api/_lib/meeting-access"
import { jsonError } from "@/lib/api/responses"
import { withAuthz } from "@/lib/auth/authz"
import { normalizeIntelligence } from "@/lib/intelligence/normalize"

/**
 * GET /api/meetings/:id/intelligence: the latest intelligence, normalized to
 * the V2 shape (legacy v1 rows get stable item ids and derived items).
 */
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

    return NextResponse.json({ intelligence: normalizeIntelligence(intelligence) })
  }
)
