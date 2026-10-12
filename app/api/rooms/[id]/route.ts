import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { withAuthz } from "@/lib/auth/authz"
import { buildRoomDetail } from "@/lib/rooms"

export const GET = withAuthz<{ id: string }>(
  "workspace:read",
  async (_request, ctx, { params }) => {
    const { id } = await params
    const rooms = await ctx.meetings.listRooms()
    const room = rooms.find((item) => item.id === id)

    if (!room) return jsonError("Room not found", 404)

    const meetings = await ctx.meetings.listMeetingsByContext(id)

    return NextResponse.json(buildRoomDetail(room, meetings))
  }
)
