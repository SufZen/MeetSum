import { NextResponse } from "next/server"

import { loadVisibleMeeting, meetingNotFound } from "@/app/api/_lib/meeting-access"
import { readMeetingAnalytics, sentimentEnabledFor } from "@/lib/analytics/service"
import { toRepoScope, withAuthz } from "@/lib/auth/authz"

/**
 * GET /api/meetings/:id/analytics (M5 D3): talk-time, WPM, monologues,
 * questions, filler rate, interruptions and per-speaker sentiment. Pure
 * metrics are recomputed on read when the transcript changed.
 */
export const GET = withAuthz<{ id: string }>("meeting:read", async (_request, ctx, { params }) => {
  const { id } = await params
  const meeting = await loadVisibleMeeting(ctx, id)

  if (!meeting) return meetingNotFound()

  const { analytics, recomputed } = await readMeetingAnalytics(toRepoScope(ctx), ctx.meetings, meeting)

  return NextResponse.json({
    analytics,
    recomputed,
    sentimentEnabled: await sentimentEnabledFor(ctx.workspace.id),
  })
})
