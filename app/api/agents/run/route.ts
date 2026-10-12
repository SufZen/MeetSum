import { NextResponse } from "next/server"

import {
  loadVisibleMeeting,
  meetingNotFound,
} from "@/app/api/_lib/meeting-access"
import { jsonError } from "@/lib/api/responses"
import { withAuthz } from "@/lib/auth/authz"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"
import { createPlatformEvent } from "@/lib/platform/events"

export const POST = withAuthz("meeting:write", async (request, ctx) => {
  const { agent = "realizeos-context", meetingId } = (await request
    .json()
    .catch(() => ({}))) as {
    agent?: string
    meetingId?: string
  }

  if (!meetingId) {
    return jsonError("meetingId is required", 400)
  }

  if (!(await loadVisibleMeeting(ctx, meetingId))) return meetingNotFound()

  const job = await enqueueMeetSumJob("realizeos.export", {
    agent,
    meetingId,
    workspaceId: ctx.workspace.id,
  })

  return NextResponse.json(
    {
      run: {
        id: job.id,
        agent,
        meetingId,
        status: "queued",
      },
      job,
      event: createPlatformEvent("agent.triggered", { agent, meetingId }),
    },
    { status: 202 }
  )
})
