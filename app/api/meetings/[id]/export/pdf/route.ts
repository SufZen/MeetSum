import { NextResponse } from "next/server"

import {
  loadVisibleMeeting,
  meetingNotFound,
} from "@/app/api/_lib/meeting-access"
import { jsonError } from "@/lib/api/responses"
import { withAuthz } from "@/lib/auth/authz"
import { contentDispositionAttachment } from "@/lib/http/content-disposition"
import { getRequestI18n, resolveScopedTimeZone } from "@/lib/i18n/server"
import { renderMeetingPdf } from "@/lib/meetings/export"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"

/**
 * Hebrew-capable PDF (M9 B2). Chrome (headings, page numbers, dates) follows
 * the viewer: `?locale=he|en` from the export menu, else the request's
 * locale. The time zone is A's chain for the caller (users.time_zone → the
 * workspace setting → env), also for API keys. Content keeps the meeting language.
 */
export const POST = withAuthz<{ id: string }>(
  "meeting:read",
  async (request, ctx, { params }) => {
    const rateLimit = await rateLimitRequest(request, RATE_LIMIT_PRESETS.exports)

    if (rateLimit.blocked) return rateLimit.blocked

    const { id } = await params
    const meeting = await loadVisibleMeeting(ctx, id)

    if (!meeting) return meetingNotFound()

    await ctx.meetings.createExportRecord({ meetingId: id, format: "pdf" })

    const requested = new URL(request.url).searchParams.get("locale")
    const i18n = await getRequestI18n(requested === "he" || requested === "en" ? { locale: requested } : {})
    const timeZone = await resolveScopedTimeZone({
      userId: ctx.principal === "user" ? ctx.user?.id : null,
      workspaceId: ctx.workspace.id,
    })

    try {
      const pdf = await renderMeetingPdf(meeting, { locale: i18n.locale, timeZone })

      return new NextResponse(new Uint8Array(pdf), {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": contentDispositionAttachment(meeting.title, "pdf", {
            date: meeting.startedAt,
            id: meeting.id,
          }),
          ...rateLimit.headers,
        },
      })
    } catch {
      return jsonError("export_failed", 500)
    }
  }
)
