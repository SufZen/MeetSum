import { NextResponse } from "next/server"

import { meetingRepository } from "@/lib/meetings/store"
import type { CreateMeetingInput } from "@/lib/meetings/repository"
import { createPlatformEvent } from "@/lib/platform/events"

export async function GET() {
  return NextResponse.json({ meetings: meetingRepository.listMeetings() })
}

export async function POST(request: Request) {
  const input = (await request.json()) as CreateMeetingInput
  const meeting = meetingRepository.createMeeting(input)
  const event = createPlatformEvent("meeting.created", { meetingId: meeting.id })

  return NextResponse.json({ meeting, event }, { status: 201 })
}
