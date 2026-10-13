import { NextResponse } from "next/server"

import {
  loadVisibleMeeting,
  meetingNotFound,
} from "@/app/api/_lib/meeting-access"
import { withAuthz } from "@/lib/auth/authz"

export const GET = withAuthz<{ id: string }>(
  "meeting:read",
  async (_request, ctx, { params }) => {
    const { id } = await params
    const meeting = await loadVisibleMeeting(ctx, id)

    if (!meeting) return meetingNotFound()

    return NextResponse.json({ meeting })
  }
)
