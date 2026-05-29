import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { renderMeetingDocx } from "@/lib/meetings/export"
import { meetingRepository } from "@/lib/meetings/store"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.exports)

  if (rateLimit.blocked) return rateLimit.blocked

  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const { id } = await params
  const meeting = await meetingRepository.getMeeting(id)

  if (!meeting) return jsonError("Meeting not found", 404)

  await meetingRepository.createExportRecord({ meetingId: id, format: "docx" })

  const docx = await renderMeetingDocx(meeting)

  return new NextResponse(new Uint8Array(docx), {
    headers: {
      "content-type":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "content-disposition": `attachment; filename="${meeting.title.replace(
        /[^a-z0-9_-]+/gi,
        "-"
      )}.docx"`,
      ...rateLimit.headers,
    },
  })
}
