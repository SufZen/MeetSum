import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import type { MeetingParticipant } from "@/lib/meetings/repository"
import { meetingRepository } from "@/lib/meetings/store"

const roles = ["organizer", "attendee", "speaker", "unknown"]
const attendanceStatuses = [
  "accepted",
  "declined",
  "tentative",
  "needs_action",
  "unknown",
]

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ participantId: string }> }
) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const { participantId } = await params
  const body = await request.json().catch(() => ({}))
  const patch: Partial<
    Pick<
      MeetingParticipant,
      "name" | "email" | "role" | "attendanceStatus" | "speakerLabel"
    >
  > = {}

  if (typeof body.name === "string") patch.name = body.name.trim()
  if (typeof body.email === "string") patch.email = body.email.trim()
  if (roles.includes(body.role)) patch.role = body.role
  if (attendanceStatuses.includes(body.attendanceStatus)) {
    patch.attendanceStatus = body.attendanceStatus
  }
  if (typeof body.speakerLabel === "string") {
    patch.speakerLabel = body.speakerLabel.trim()
  }

  try {
    const participant = await meetingRepository.updateMeetingParticipant(
      participantId,
      patch
    )

    return NextResponse.json({ participant })
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Unable to update participant",
      404
    )
  }
}
