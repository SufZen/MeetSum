import { NextResponse } from "next/server"

import { requireAppAccess } from "@/lib/api/responses"
import { meetingRepository } from "@/lib/meetings/store"
import { suggestRooms } from "@/lib/rooms"

export async function GET(request: Request) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const rooms = await meetingRepository.listRooms()
  const existingNames = rooms.map((room) => room.name)
  const meetings = await meetingRepository.listMeetings()

  return NextResponse.json({
    suggestions: suggestRooms(meetings, existingNames),
  })
}
