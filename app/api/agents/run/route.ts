import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"
import { createPlatformEvent } from "@/lib/platform/events"

export async function POST(request: Request) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) {
    return unauthorized
  }

  const { agent = "realizeos-context", meetingId } = (await request.json()) as {
    agent?: string
    meetingId?: string
  }

  if (!meetingId) {
    return jsonError("meetingId is required", 400)
  }

  const job = await enqueueMeetSumJob("realizeos.export", {
    agent,
    meetingId,
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
}
