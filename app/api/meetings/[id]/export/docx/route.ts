import { NextResponse } from "next/server"

import {
  loadVisibleMeeting,
  meetingNotFound,
} from "@/app/api/_lib/meeting-access"
import { jsonError } from "@/lib/api/responses"
import { withAuthz } from "@/lib/auth/authz"
import { contentDispositionAttachment } from "@/lib/http/content-disposition"
import { exportLocaleFor, renderMeetingDocx } from "@/lib/meetings/export"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"

export const POST = withAuthz<{ id: string }>(
  "meeting:read",
  async (request, ctx, { params }) => {
    const rateLimit = await rateLimitRequest(request, RATE_LIMIT_PRESETS.exports)

    if (rateLimit.blocked) return rateLimit.blocked

    const { id } = await params
    const meeting = await loadVisibleMeeting(ctx, id)

    if (!meeting) return meetingNotFound()

    await ctx.meetings.createExportRecord({ meetingId: id, format: "docx" })

    try {
      const docx = await renderMeetingDocx(meeting, {
        locale: exportLocaleFor(meeting, new URL(request.url).searchParams.get("locale")),
      })

      return new NextResponse(new Uint8Array(docx), {
        headers: {
          "content-type":
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "content-disposition": contentDispositionAttachment(meeting.title, "docx", { date: meeting.startedAt, id: meeting.id }),
          ...rateLimit.headers,
        },
      })
    } catch (error) {
      return jsonError(
        error instanceof Error
          ? error.message
          : "Failed to generate DOCX export",
        500
      )
    }
  }
)
