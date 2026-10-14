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
  rejectSpeaker,
  resetSpeaker,
  speakerNotFound,
} from "@/app/api/meetings/[id]/speakers/_lib/speaker-mapping"
import { jsonError } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { withAuthz } from "@/lib/auth/authz"
import type { MeetingSpeaker } from "@/lib/meetings/repository"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"
import { requestMeetingReindex } from "@/lib/search/index-trigger"

const ACTIONS = ["confirm", "reject", "reset"] as const

type SpeakerAction = (typeof ACTIONS)[number]

/**
 * PATCH /api/meetings/:id/speakers/:speakerId
 * Body: { action: "confirm" | "reject" | "reset", participantId?, displayName? }
 *
 * confirm — maps the speaker to a meeting participant or a typed name (or,
 *   with neither, accepts the current suggestion) and remembers the person
 *   in the workspace speaker profiles.
 * reject  — marks the suggestion wrong; the rejected pair is kept so it is
 *   never suggested again.
 * reset   — back to unmapped.
 */
export const PATCH = withAuthz<{ id: string; speakerId: string }>(
  "meeting:write",
  async (request, ctx, { params }) => {
    const rateLimit = await rateLimitRequest(request, RATE_LIMIT_PRESETS.api)

    if (rateLimit.blocked) return rateLimit.blocked

    const { id, speakerId } = await params
    const body = (await request.json().catch(() => ({}))) as {
      action?: unknown
      participantId?: unknown
      displayName?: unknown
    }
    const action = body.action as SpeakerAction

    if (!ACTIONS.includes(action)) {
      return jsonError("action must be one of confirm, reject, reset", 400)
    }
    if (body.displayName !== undefined && typeof body.displayName !== "string") {
      return jsonError("displayName must be a string", 400)
    }
    if (typeof body.displayName === "string" && body.displayName.trim().length > 120) {
      return jsonError("displayName must be at most 120 characters", 400)
    }

    if (!(await loadVisibleMeeting(ctx, id))) return meetingNotFound()

    const { speaker } = await findSpeaker(ctx, id, { id: speakerId })

    if (!speaker) return speakerNotFound()

    let updated: MeetingSpeaker
    let participantId: string | undefined

    if (action === "confirm") {
      const participants = await ctx.meetings.listMeetingParticipants(id)
      const requestedId =
        typeof body.participantId === "string" && body.participantId
          ? body.participantId
          : undefined
      const displayName =
        typeof body.displayName === "string" ? body.displayName.trim() : undefined
      // With neither a participant nor a name, accept the suggestion.
      const fallback = !requestedId && !displayName ? speaker.suggestion : undefined

      participantId = requestedId ?? fallback?.participantId
      const participant = participantId
        ? participants.find((candidate) => candidate.id === participantId)
        : undefined

      // Child-id IDOR guard: the participant must belong to this meeting.
      if (participantId && !participant) return participantNotFound()

      const name = displayName || (participant ? undefined : fallback?.name)

      if (!participant && !name) {
        return jsonError("participantId or displayName is required to confirm", 400)
      }

      updated = await confirmSpeaker(ctx, id, speaker, {
        participant,
        displayName: name,
      })
    } else if (action === "reject") {
      updated = await rejectSpeaker(ctx, id, speaker)
    } else {
      updated = await resetSpeaker(ctx, id, speaker)
    }

    await recordAuditLog({
      ...auditActor(ctx),
      action: "meeting.speaker.mapped",
      targetType: "meeting",
      targetId: id,
      metadata: {
        operation: action,
        speakerId: speaker.id,
        label: speaker.label,
        ...(participantId ? { participantId } : {}),
        ...(action === "reject" && speaker.suggestion
          ? {
              rejectedCandidate:
                speaker.suggestion.participantId ?? speaker.suggestion.profileId,
            }
          : {}),
      },
    })

    await requestMeetingReindex({ workspaceId: ctx.workspace.id, meetingId: id, reason: "speakers" })

    return NextResponse.json({ speaker: updated }, { headers: rateLimit.headers })
  }
)
