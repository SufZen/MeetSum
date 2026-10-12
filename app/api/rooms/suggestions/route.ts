import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"
import { suggestRooms } from "@/lib/rooms"

export const GET = withAuthz("workspace:read", async (_request, ctx) => {
  const rooms = await ctx.meetings.listRooms()
  const existingNames = rooms.map((room) => room.name)
  const meetings = await ctx.meetings.listMeetings()

  return NextResponse.json({
    suggestions: suggestRooms(meetings, existingNames),
  })
})
