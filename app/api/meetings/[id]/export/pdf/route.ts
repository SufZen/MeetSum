import { NextResponse } from "next/server"

import {
  loadVisibleMeeting,
  meetingNotFound,
} from "@/app/api/_lib/meeting-access"
import { withAuthz } from "@/lib/auth/authz"
import { contentDispositionAttachment } from "@/lib/http/content-disposition"
import { renderMeetingPdf } from "@/lib/meetings/export"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"

export const POST = withAuthz<{ id: string }>(
  "meeting:read",
  async (request, ctx, { params }) => {
    const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.exports)

    if (rateLimit.blocked) return rateLimit.blocked

    const { id } = await params
    const meeting = await loadVisibleMeeting(ctx, id)

    if (!meeting) return meetingNotFound()

    await ctx.meetings.createExportRecord({ meetingId: id, format: "pdf" })

    const pdf = renderMeetingPdf(meeting)

    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": contentDispositionAttachment(meeting.title, "pdf"),
        ...rateLimit.headers,
      },
    })
  }
)
