import { NextResponse } from "next/server"

import { loadVisibleMeeting, meetingNotFound } from "@/app/api/_lib/meeting-access"
import { jsonError } from "@/lib/api/responses"
import { recomputeMeetingAnalytics, sentimentEnabledFor } from "@/lib/analytics/service"
import { toRepoScope, withAuthz } from "@/lib/auth/authz"

/**
 * POST /api/meetings/:id/analytics/sentiment (M5 D3): re-runs sentiment.
 * Cached turns are reused unless `{force: true}`. A sentiment failure still
 * stores fresh metrics and answers 502 with them.
 */
export const POST = withAuthz<{ id: string }>("meeting:write", async (request, ctx, { params }) => {
  const { id } = await params
  const meeting = await loadVisibleMeeting(ctx, id)

  if (!meeting) return meetingNotFound()
  if (!(await sentimentEnabledFor(ctx.workspace.id))) {
    return NextResponse.json({ error: "sentiment_disabled" }, { status: 409 })
  }

  const body = (await request.json().catch(() => ({}))) as { force?: unknown }

  if (body.force !== undefined && typeof body.force !== "boolean") {
    return jsonError("force must be a boolean", 400)
  }

  const result = await recomputeMeetingAnalytics(toRepoScope(ctx), ctx.meetings, meeting, {
    sentiment: true,
    force: body.force === true,
    interactive: true,
  })

  return NextResponse.json(
    { analytics: result.analytics, sentiment: result.sentiment },
    { status: result.sentiment === "failed" ? 502 : 200 }
  )
})
