import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"

export const GET = withAuthz("workspace:read", async (_request, ctx) =>
  NextResponse.json({ rooms: await ctx.meetings.listRooms() })
)
