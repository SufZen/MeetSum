import { NextResponse } from "next/server"

import {
  loadVisibleMeeting,
  meetingNotFound,
} from "@/app/api/_lib/meeting-access"
import { jsonError } from "@/lib/api/responses"
import { withAuthz } from "@/lib/auth/authz"
import { parseRequiredString } from "@/lib/meetings/validation"

export const POST = withAuthz<{ id: string }>(
  "meeting:read",
  async (request, ctx, { params }) => {
    const { id } = await params
    let question

    try {
      question = parseRequiredString(
        await request.json().catch(() => ({})),
        "question"
      )
    } catch (error) {
      return jsonError(
        error instanceof Error ? error.message : "question is required",
        400
      )
    }

    if (!(await loadVisibleMeeting(ctx, id))) return meetingNotFound()

    try {
      return NextResponse.json({
        answer: await ctx.meetings.askMeetingMemory(id, question),
      })
    } catch (error) {
      return jsonError(
        error instanceof Error ? error.message : "Unknown error",
        404
      )
    }
  }
)
