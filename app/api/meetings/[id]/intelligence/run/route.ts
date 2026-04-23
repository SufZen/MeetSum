import { NextResponse } from "next/server"

import { jsonError, requireApiKey } from "@/lib/api/responses"
import { meetingRepository } from "@/lib/meetings/store"
import { createPlatformEvent } from "@/lib/platform/events"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = requireApiKey(request)

  if (unauthorized) {
    return unauthorized
  }

  const { id } = await params

  try {
    const intelligence = await meetingRepository.runMeetingIntelligence(id)

    return NextResponse.json({
      intelligence,
      event: createPlatformEvent("summary.created", { meetingId: id }),
    })
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Unable to run intelligence",
      404
    )
  }
}
