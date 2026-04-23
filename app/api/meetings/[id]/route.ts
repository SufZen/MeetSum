import { NextResponse } from "next/server"

import { jsonError, requireApiKey } from "@/lib/api/responses"
import { meetingRepository } from "@/lib/meetings/store"

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = requireApiKey(_request)

  if (unauthorized) {
    return unauthorized
  }

  const { id } = await params
  const meeting = await meetingRepository.getMeeting(id)

  if (!meeting) {
    return jsonError("Meeting not found", 404)
  }

  return NextResponse.json({ meeting })
}
