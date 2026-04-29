import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { meetingRepository } from "@/lib/meetings/store"
import { parseCreateMeetingInput } from "@/lib/meetings/validation"
import { createPlatformEvent } from "@/lib/platform/events"

export async function GET(request: Request) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) {
    return unauthorized
  }

  const searchParams = new URL(request.url).searchParams
  const query = searchParams.get("query")?.trim()
  const requestedLimit = Number(searchParams.get("limit") ?? 50)
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(Math.trunc(requestedLimit), 100))
    : 50

  return NextResponse.json({
    meetings: query
      ? await meetingRepository.searchMeetings(query, { limit })
      : await meetingRepository.listMeetings({ limit }),
  })
}

export async function POST(request: Request) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) {
    return unauthorized
  }

  let input

  try {
    input = parseCreateMeetingInput(await request.json())
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Invalid meeting payload",
      400
    )
  }

  const meeting = await meetingRepository.createMeeting(input)
  const event = createPlatformEvent("meeting.created", {
    meetingId: meeting.id,
  })

  return NextResponse.json({ meeting, event }, { status: 201 })
}
