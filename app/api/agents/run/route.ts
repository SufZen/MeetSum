import { NextResponse } from "next/server"

import { jsonError, requireApiKey } from "@/lib/api/responses"
import { createPlatformEvent } from "@/lib/platform/events"

export async function POST(request: Request) {
  const unauthorized = requireApiKey(request)

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

  return NextResponse.json(
    {
      run: {
        id: `run_${crypto.randomUUID()}`,
        agent,
        meetingId,
        status: "queued",
      },
      event: createPlatformEvent("agent.triggered", { agent, meetingId }),
    },
    { status: 202 }
  )
}
