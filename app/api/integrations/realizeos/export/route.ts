import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"
import { meetingRepository } from "@/lib/meetings/store"
import { createPlatformEvent } from "@/lib/platform/events"

export async function POST(request: Request) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) {
    return unauthorized
  }

  const { meetingId, contextId } = (await request.json()) as {
    meetingId?: string
    contextId?: string
  }

  if (!meetingId) {
    return jsonError("meetingId is required", 400)
  }

  try {
    const intelligence =
      (await meetingRepository.getMeetingIntelligence(meetingId)) ??
      (await meetingRepository.runMeetingIntelligence(meetingId))
    const suggestion = await meetingRepository.createSuggestedAgentRun({
      meetingId,
      target: "realizeos",
      payload: {
        contextId,
        intelligence,
      },
    })
    const job = await enqueueMeetSumJob("realizeos.export", {
      meetingId,
      contextId,
      suggestionId: suggestion.id,
    })

    return NextResponse.json({
      suggestion,
      job,
      event: createPlatformEvent("agent.triggered", {
        agent: "realizeos-export",
        meetingId,
      }),
    })
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Unable to create RealizeOS export",
      404
    )
  }
}
