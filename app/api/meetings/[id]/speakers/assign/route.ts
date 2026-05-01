import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { meetingRepository } from "@/lib/meetings/store"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const { id } = await params
  const body = await request.json().catch(() => ({}))

  if (!body.speakerLabel || !body.participantId) {
    return jsonError("speakerLabel and participantId are required", 400)
  }

  try {
    const participant = await meetingRepository.assignSpeakerToParticipant(
      id,
      String(body.speakerLabel),
      String(body.participantId)
    )

    return NextResponse.json({ participant })
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Unable to assign speaker",
      400
    )
  }
}
