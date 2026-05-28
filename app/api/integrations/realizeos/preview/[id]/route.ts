import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { createRealizeOSPayload } from "@/lib/integrations/realizeos"
import { meetingRepository } from "@/lib/meetings/store"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const { id } = await params
  const meeting = await meetingRepository.getMeeting(id)

  if (!meeting) return jsonError("Meeting not found", 404)

  try {
    const payload = createRealizeOSPayload(meeting)

    return NextResponse.json(payload)
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Unable to build RealizeOS payload",
      400
    )
  }
}
