import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { meetingRepository } from "@/lib/meetings/store"
import { buildRoomDetail } from "@/lib/rooms"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const { id } = await params
  const rooms = await meetingRepository.listRooms()
  const room = rooms.find((item) => item.id === id)

  if (!room) return jsonError("Room not found", 404)

  const meetings = await meetingRepository.listMeetingsByContext(id)

  return NextResponse.json(buildRoomDetail(room, meetings))
}
