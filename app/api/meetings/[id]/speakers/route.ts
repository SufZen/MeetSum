import { NextResponse } from "next/server"

import {
  auditActor,
  loadVisibleMeeting,
  meetingNotFound,
} from "@/app/api/_lib/meeting-access"
import { jsonError } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { withAuthz } from "@/lib/auth/authz"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"

type SpeakerMapping = {
  speaker: string
  person: string
}

/**
 * POST /api/meetings/:id/speakers — Assign speakers to persons.
 * Body: { mappings: [{ speaker: "Speaker 1", person: "Alice" }] }
 * Updates transcript segments with the assigned person names.
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

    // Build lookup from speaker label to person name
    const speakerMap = new Map<string, string>()
    for (const { speaker, person } of mappings) {
      speakerMap.set(speaker, person)
    }

    // Apply mappings to transcript segments
    const updatedSegments = transcript.map((segment) => {
      const person = speakerMap.get(segment.speaker)
      return person ? { ...segment, speaker: person } : segment
    })

    const changedCount = updatedSegments.filter(
      (s, i) => s.speaker !== transcript[i].speaker
    ).length

    // Persist updated segments
    await ctx.meetings.replaceTranscriptSegments(id, updatedSegments)

    await recordAuditLog({
      ...auditActor(ctx),
      action: "meeting.reprocessed",
      targetType: "meeting",
      targetId: id,
      metadata: {
        operation: "speaker_assignment",
        mappings: Object.fromEntries(speakerMap),
        segmentsUpdated: changedCount,
      },
    })

    return NextResponse.json(
      {
        mappingsApplied: mappings.length,
        segmentsUpdated: changedCount,
        totalSegments: updatedSegments.length,
      },
      { headers: rateLimit.headers }
    )
  }
)

/**
 * GET /api/meetings/:id/speakers — List unique speaker labels in transcript.
 */
export const GET = withAuthz<{ id: string }>(
  "meeting:read",
  async (request, ctx, { params }) => {
    const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.api)

    if (rateLimit.blocked) return rateLimit.blocked

    const { id } = await params
    const meeting = await loadVisibleMeeting(ctx, id)

    if (!meeting) return meetingNotFound()

    const speakers = new Map<string, number>()

    for (const segment of meeting.transcript ?? []) {
      speakers.set(segment.speaker, (speakers.get(segment.speaker) ?? 0) + 1)
    }

    const speakerList = [...speakers.entries()]
      .map(([label, segmentCount]) => ({ label, segmentCount }))
      .sort((a, b) => b.segmentCount - a.segmentCount)

    return NextResponse.json(
      { speakers: speakerList, participants: meeting.participants },
      { headers: rateLimit.headers }
    )
  }
)
