import { NextResponse } from "next/server"

import {
  loadVisibleMeeting,
  meetingNotFound,
} from "@/app/api/_lib/meeting-access"
import { withAuthz } from "@/lib/auth/authz"
import { contentDispositionAttachment } from "@/lib/http/content-disposition"
import { exportLocaleFor, renderMeetingMarkdown } from "@/lib/meetings/export"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"

export const POST = withAuthz<{ id: string }>(
  "meeting:read",
  async (request, ctx, { params }) => {
    const rateLimit = await rateLimitRequest(request, RATE_LIMIT_PRESETS.exports)

    if (rateLimit.blocked) return rateLimit.blocked

    const { id } = await params
    const meeting = await loadVisibleMeeting(ctx, id)

    if (!meeting) return meetingNotFound()

    await ctx.meetings.createExportRecord({ meetingId: id, format: "markdown" })

    const locale = exportLocaleFor(meeting, new URL(request.url).searchParams.get("locale"))

    return new NextResponse(renderMeetingMarkdown(meeting, { locale }), {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": contentDispositionAttachment(meeting.title, "md", { date: meeting.startedAt, id: meeting.id }),
        ...rateLimit.headers,
      },
    })
  }
)
