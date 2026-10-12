import { NextResponse } from "next/server"

import {
  loadVisibleMeeting,
  meetingNotFound,
} from "@/app/api/_lib/meeting-access"
import { jsonError } from "@/lib/api/responses"
import { withAuthz } from "@/lib/auth/authz"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"
import { createPlatformEvent } from "@/lib/platform/events"

export const POST = withAuthz<{ id: string }>(
  "meeting:write",
  async (_request, ctx, { params }) => {
    const { id } = await params

    if (!(await loadVisibleMeeting(ctx, id))) return meetingNotFound()

    try {
      const job = await enqueueMeetSumJob("meeting.summarize", {
        meetingId: id,
        workspaceId: ctx.workspace.id,
      })

      return NextResponse.json(
        {
          job,
          event: createPlatformEvent("summary.created", { meetingId: id }),
        },
        { status: 202 }
      )
    } catch (error) {
      return jsonError(
        error instanceof Error ? error.message : "Unable to run intelligence",
        404
      )
    }
  }
)
