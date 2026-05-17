import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { renderMeetingMarkdown } from "@/lib/meetings/export"
import { meetingRepository } from "@/lib/meetings/store"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const { id } = await params
  const meeting = await meetingRepository.getMeeting(id)

  if (!meeting) return jsonError("Meeting not found", 404)

  await meetingRepository.createExportRecord({ meetingId: id, format: "markdown" })

  return new NextResponse(renderMeetingMarkdown(meeting), {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${meeting.title.replace(
        /[^a-z0-9_-]+/gi,
        "-"
      )}.md"`,
    },
  })
}
