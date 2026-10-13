import { NextResponse } from "next/server"

import { auditActor } from "@/app/api/_lib/meeting-access"
import {
  editActorUserId,
  mutationResponse,
  parseRevision,
  transcriptErrorResponse,
} from "@/app/api/meetings/[id]/transcript/_lib/transcript-route"
import { jsonError } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { withAuthz } from "@/lib/auth/authz"
import type { SegmentPatch } from "@/lib/meetings/repository"
import { transcriptEditMaxChars } from "@/lib/meetings/transcript-edit"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"
import { requestMeetingReindex } from "@/lib/search/index-trigger"

const SPEAKER_NAME_MAX_CHARS = 120

type ParsedPatch = Omit<SegmentPatch, "actorUserId">

function parseBody(body: Record<string, unknown>): ParsedPatch | string {
  const revision = parseRevision(body.revision)

  if (revision === undefined) return "revision must be a non-negative integer"

  const patch: ParsedPatch = { expectedRevision: revision }

  if (body.text !== undefined) {
    if (typeof body.text !== "string") return "text must be a string"

    const text = body.text.normalize("NFC").trim()
    const max = transcriptEditMaxChars()

    if (!text) return "text must not be empty"
    if (Array.from(text).length > max) return `text must be at most ${max} characters`
    patch.text = text
  }

  if (body.speakerId !== undefined && body.newSpeakerName !== undefined) {
    return "send either speakerId or newSpeakerName, not both"
  }
  if (body.speakerId !== undefined) {
    if (typeof body.speakerId !== "string" || !body.speakerId) {
      return "speakerId must be a non-empty string"
    }
    patch.speakerId = body.speakerId
  }
  if (body.newSpeakerName !== undefined) {
    if (typeof body.newSpeakerName !== "string") return "newSpeakerName must be a string"

    const name = body.newSpeakerName.normalize("NFC").trim().replace(/\s+/gu, " ")

    if (!name) return "newSpeakerName must not be empty"
    if (Array.from(name).length > SPEAKER_NAME_MAX_CHARS) {
      return `newSpeakerName must be at most ${SPEAKER_NAME_MAX_CHARS} characters`
    }
    patch.newSpeakerName = name
  }
  if (body.scope !== undefined) {
    if (body.scope !== "segment" && body.scope !== "turn") {
      return "scope must be segment or turn"
    }
    patch.scope = body.scope
  }
  if (patch.text === undefined && !patch.speakerId && !patch.newSpeakerName) {
    return "nothing to change: send text, speakerId or newSpeakerName"
  }

  return patch
}

/**
 * PATCH /api/meetings/:id/transcript/segments/:segmentId
 * Body: { revision, text?, speakerId? | newSpeakerName?, scope?: "segment" | "turn" }
 *
 * Edits one segment (words realigned so untouched timings survive) and/or
 * reassigns its speaker (`turn`: every segment of the same turn and old
 * speaker). 409 `{error:"conflict", segment}` when `revision` is stale. The
 * audit entry never carries transcript text.
 */
export const PATCH = withAuthz<{ id: string; segmentId: string }>(
  "meeting:write",
  async (request, ctx, { params }) => {
    const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.api)

    if (rateLimit.blocked) return rateLimit.blocked

    const { id, segmentId } = await params
    const body = await request.json().catch(() => undefined)

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return jsonError("body must be a JSON object", 400)
    }

    const parsed = parseBody(body as Record<string, unknown>)

    if (typeof parsed === "string") return jsonError(parsed, 400)

    try {
      const result = await ctx.meetings.updateTranscriptSegment(id, segmentId, {
        ...parsed,
        actorUserId: editActorUserId(ctx),
      })

      if ((result.segment.revision ?? 0) !== parsed.expectedRevision) {
        const fields = [
          ...(parsed.text !== undefined ? ["text"] : []),
          ...(parsed.speakerId || parsed.newSpeakerName ? ["speaker"] : []),
        ]

        await recordAuditLog({
          ...auditActor(ctx),
          action: "meeting.transcript.edited",
          targetType: "meeting",
          targetId: id,
          metadata: {
            segmentId,
            fields,
            scope: parsed.scope ?? "segment",
            revision: result.segment.revision ?? 0,
            ...(parsed.text !== undefined ? { textLength: Array.from(parsed.text).length } : {}),
            ...(parsed.newSpeakerName ? { newSpeaker: true } : {}),
          },
        })
      }

      await requestMeetingReindex({ workspaceId: ctx.workspace.id, meetingId: id, reason: "transcript.edited" })

      return NextResponse.json(mutationResponse(result))
    } catch (error) {
      return transcriptErrorResponse(error)
    }
  }
)
