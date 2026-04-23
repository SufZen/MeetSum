import { NextResponse } from "next/server"

import { jsonError, requireApiKey } from "@/lib/api/responses"
import { meetingRepository } from "@/lib/meetings/store"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = requireApiKey(request)

  if (unauthorized) {
    return unauthorized
  }

  const { id } = await params
  const meeting = await meetingRepository.getMeeting(id)

  if (!meeting) {
    return jsonError("Meeting not found", 404)
  }

  const intelligence =
    (await meetingRepository.getMeetingIntelligence(id)) ??
    meeting.intelligence

  if (!intelligence) {
    return jsonError("Meeting intelligence has not been generated", 404)
  }

  return NextResponse.json({ intelligence })
}
