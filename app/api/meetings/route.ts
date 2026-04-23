import { NextResponse } from "next/server"

import { jsonError, requireApiKey } from "@/lib/api/responses"
import { meetingRepository } from "@/lib/meetings/store"
import { parseCreateMeetingInput } from "@/lib/meetings/validation"
import { createPlatformEvent } from "@/lib/platform/events"

export async function GET(request: Request) {
  const unauthorized = requireApiKey(request)

  if (unauthorized) {
    return unauthorized
  }

  return NextResponse.json({ meetings: await meetingRepository.listMeetings() })
}

export async function POST(request: Request) {
  const unauthorized = requireApiKey(request)

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
