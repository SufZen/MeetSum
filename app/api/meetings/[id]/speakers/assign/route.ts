import { NextResponse } from "next/server"

import {
  auditActor,
  loadVisibleMeeting,
  meetingNotFound,
} from "@/app/api/_lib/meeting-access"
import {
  confirmSpeaker,
  findSpeaker,
  participantNotFound,
  speakerNotFound,
} from "@/app/api/meetings/[id]/speakers/_lib/speaker-mapping"
import { jsonError } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { withAuthz } from "@/lib/auth/authz"

/**
 * POST /api/meetings/:id/speakers/assign — legacy single mapping.
 * Body: { speakerLabel, participantId }. Confirms the speaker row as the
 * participant; never rewrites segments.
 */
export const POST = withAuthz<{ id: string }>(
  "meeting:write",
  async (request, ctx, { params }) => {
    const { id } = await params
    const body = await request.json().catch(() => ({}))

    if (!body.speakerLabel || !body.participantId) {
      return jsonError("speakerLabel and participantId are required", 400)
    }

    if (!(await loadVisibleMeeting(ctx, id))) return meetingNotFound()

    // Child-id IDOR guard: the participant must belong to this meeting.
    const participantId = String(body.participantId)
    const participants = await ctx.meetings.listMeetingParticipants(id)
    const participant = participants.find((candidate) => candidate.id === participantId)

    if (!participant) return participantNotFound()

    const speakerLabel = String(body.speakerLabel)
    const { speaker } = await findSpeaker(ctx, id, { label: speakerLabel })

    if (!speaker) return speakerNotFound()

    const updated = await confirmSpeaker(ctx, id, speaker, { participant })

    await recordAuditLog({
      ...auditActor(ctx),
      action: "meeting.speaker.mapped",
      targetType: "meeting",
      targetId: id,
      metadata: {
        operation: "legacy_assign",
        speakerId: speaker.id,
        label: speaker.label,
        participantId,
      },
    })

    return NextResponse.json({
      participant: { ...participant, speakerLabel },
      speaker: updated,
    })
  }
)
