import { NextResponse } from "next/server"

import {
  loadVisibleMeeting,
  meetingNotFound,
} from "@/app/api/_lib/meeting-access"
import { jsonError } from "@/lib/api/responses"
import { withAuthz } from "@/lib/auth/authz"
import { renderMeetingDocx } from "@/lib/meetings/export"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"

export const POST = withAuthz<{ id: string }>(
  "meeting:read",
  async (request, ctx, { params }) => {
    const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.exports)

    if (rateLimit.blocked) return rateLimit.blocked

    const { id } = await params
    const meeting = await loadVisibleMeeting(ctx, id)

    if (!meeting) return meetingNotFound()

    await ctx.meetings.createExportRecord({ meetingId: id, format: "docx" })

    try {
      const docx = await renderMeetingDocx(meeting)
      const safeTitle =
        meeting.title.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") ||
        "meetsum-export"

      return new NextResponse(new Uint8Array(docx), {
        headers: {
          "content-type":
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "content-disposition": `attachment; filename="${safeTitle}.docx"`,
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
