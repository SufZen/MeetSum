import { NextResponse } from "next/server"

import {
  loadVisibleMeeting,
  meetingManageForbidden,
  meetingNotFound,
} from "@/app/api/_lib/meeting-access"
import { jsonError } from "@/lib/api/responses"
import { canManageMeeting, withAuthz } from "@/lib/auth/authz"
import type { MeetingParticipant } from "@/lib/meetings/repository"

const roles = ["organizer", "attendee", "speaker", "unknown"]
const attendanceStatuses = [
  "accepted",
  "declined",
  "tentative",
  "needs_action",
  "unknown",
]

function normalizeEmail(value?: string) {
  return (value ?? "").trim().toLowerCase()
}

export const PATCH = withAuthz<{ id: string; participantId: string }>(
  "meeting:write",
  async (request, ctx, { params }) => {
    const { id, participantId } = await params
    const meeting = await loadVisibleMeeting(ctx, id)

    if (!meeting) return meetingNotFound()

    // Child-id IDOR guard: the participant must belong to this meeting.
    const participants = await ctx.meetings.listMeetingParticipants(id)
    const existing = participants.find(
      (participant) => participant.id === participantId
    )

    if (!existing) return jsonError("Participant not found", 404)

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

    // Participant emails grant access to private meetings, so changing one
    // needs owner-or-admin rights regardless of the current visibility: a
    // member could otherwise plant their own email on a workspace meeting
    // and keep access after it is made private.
    if (
      patch.email !== undefined &&
      normalizeEmail(patch.email) !== normalizeEmail(existing.email) &&
      !canManageMeeting(ctx, meeting)
    ) {
      return meetingManageForbidden()
    }

    try {
      const participant = await ctx.meetings.updateMeetingParticipant(
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
)
