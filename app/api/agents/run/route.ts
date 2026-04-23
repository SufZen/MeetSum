import { NextResponse } from "next/server"

import { createPlatformEvent } from "@/lib/platform/events"

export async function POST(request: Request) {
  const { agent = "realizeos-context", meetingId } = (await request.json()) as {
    agent?: string
    meetingId?: string
  }

  if (!meetingId) {
    return NextResponse.json({ error: "meetingId is required" }, { status: 400 })
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
    { status: 202 },
  )
}
