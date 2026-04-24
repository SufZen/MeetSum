import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"
import { createPlatformEvent } from "@/lib/platform/events"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) {
    return unauthorized
  }

  const { id } = await params

  try {
    const job = await enqueueMeetSumJob("meeting.summarize", { meetingId: id })

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
