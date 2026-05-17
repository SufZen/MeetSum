import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { meetingRepository } from "@/lib/meetings/store"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const { id } = await params

  try {
    const participants = await meetingRepository.listMeetingParticipants(id)

    return NextResponse.json({ participants })
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Unable to load participants",
      404
    )
  }
}
