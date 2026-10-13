import { NextResponse } from "next/server"

import {
  auditActor,
  loadVisibleMeeting,
  meetingNotFound,
} from "@/app/api/_lib/meeting-access"
import {
  confirmSpeaker,
  findParticipantByName,
} from "@/app/api/meetings/[id]/speakers/_lib/speaker-mapping"
import { jsonError } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { withAuthz } from "@/lib/auth/authz"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"

type SpeakerMapping = {
  speaker: string
  person: string
}

/**
 * GET /api/meetings/:id/speakers — diarized speakers of the meeting with
 * their mapping state, the meeting participants and the total talk time.
 */
export const GET = withAuthz<{ id: string }>(
  "meeting:read",
  async (request, ctx, { params }) => {
    const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.api)

    if (rateLimit.blocked) return rateLimit.blocked

    const { id } = await params

    if (!(await loadVisibleMeeting(ctx, id))) return meetingNotFound()

    const [speakers, participants] = await Promise.all([
      ctx.meetings.listMeetingSpeakers(id),
      ctx.meetings.listMeetingParticipants(id),
    ])
    const totalTalkTimeMs = speakers.reduce(
      (sum, speaker) => sum + speaker.talkTimeMs,
      0
    )

    return NextResponse.json(
      { speakers, participants, totalTalkTimeMs },
      { headers: rateLimit.headers }
    )
  }
)

/**
 * POST /api/meetings/:id/speakers — legacy bulk mapping.
 * Body: { mappings: [{ speaker: "Speaker 1", person: "Alice" }] }
 * Confirms each speaker row (participant when the name or email matches,
 * otherwise a display name). Segments are never rewritten.
 */
export const POST = withAuthz<{ id: string }>(
  "meeting:write",
  async (request, ctx, { params }) => {
    const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.api)

    if (rateLimit.blocked) return rateLimit.blocked

    const { id } = await params
    const meeting = await loadVisibleMeeting(ctx, id)

    if (!meeting) return meetingNotFound()

    const transcript = meeting.transcript ?? []

    if (!transcript.length) {
      return jsonError("Meeting has no transcript to assign speakers to", 400)
    }

    const body = (await request.json().catch(() => ({}))) as {
      mappings?: unknown
    }

    if (!Array.isArray(body.mappings) || body.mappings.length === 0) {
      return jsonError("mappings must be a non-empty array", 400)
    }

    const mappings: SpeakerMapping[] = body.mappings
      .filter(
        (m): m is { speaker: unknown; person: unknown } =>
          typeof m === "object" && m !== null
      )
      .map((m) => ({
        speaker: String(m.speaker ?? "").trim(),
        person: String(m.person ?? "").trim(),
      }))
      .filter((m) => m.speaker && m.person)

    if (mappings.length === 0) {
      return jsonError("No valid speaker→person mappings provided", 400)
    }

    const [speakers, participants] = await Promise.all([
      ctx.meetings.listMeetingSpeakers(id),
      ctx.meetings.listMeetingParticipants(id),
    ])
    const applied: Array<{ speakerId: string; label: string; person: string }> = []
    let segmentsUpdated = 0

    for (const { speaker: label, person } of mappings) {
      const speaker = speakers.find(
        (candidate) => candidate.label === label || candidate.displayName === label
      )

      if (!speaker) continue

      const participant = findParticipantByName(participants, person)

      await confirmSpeaker(ctx, id, speaker, {
        participant,
        displayName: participant ? undefined : person,
      })
      applied.push({ speakerId: speaker.id, label: speaker.label, person })
      segmentsUpdated += transcript.filter(
        (segment) =>
          segment.speakerId === speaker.id ||
          (!segment.speakerId && segment.speaker === speaker.label)
      ).length
    }

    if (applied.length) {
      await recordAuditLog({
        ...auditActor(ctx),
        action: "meeting.speaker.mapped",
        targetType: "meeting",
        targetId: id,
        metadata: { operation: "legacy_bulk", mappings: applied },
      })
    }

    return NextResponse.json(
      {
        mappingsApplied: applied.length,
        segmentsUpdated,
        totalSegments: transcript.length,
      },
      { headers: rateLimit.headers }
    )
  }
)
