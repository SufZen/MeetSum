import { NextResponse } from "next/server"

import { auditActor, meetingNotFound, principalKey } from "@/app/api/_lib/meeting-access"
import { jsonError } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { withAuthz } from "@/lib/auth/authz"
import { ClipValidationError } from "@/lib/clips/range"
import { canManageClip, clipStoreContext } from "@/lib/clips/route-context"
import {
  ClipLimitError,
  ClipNotFoundError,
  ClipOwnerRequiredError,
  ClipQuotaUnavailableError,
  createClip,
  listClips,
} from "@/lib/clips/store"
import { toClipWire, type CreateClipInput } from "@/lib/clips/types"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"
import { rateLimitRequest, type RateLimitConfig } from "@/lib/rate-limit"

const CLIP_CREATE_LIMIT: RateLimitConfig = { maxRequests: 20, windowMs: 3_600_000 }

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const MAX_SEGMENT_IDS = 500

function parseCreateInput(body: unknown): CreateClipInput | undefined {
  if (!body || typeof body !== "object") return undefined

  const record = body as Record<string, unknown>
  const title = typeof record.title === "string" ? record.title : undefined

  if (Array.isArray(record.segmentIds)) {
    const ids = record.segmentIds

    if (!ids.length || ids.length > MAX_SEGMENT_IDS) return undefined
    if (!ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 200)) {
      return undefined
    }
    return { segmentIds: ids as string[], ...(title !== undefined ? { title } : {}) }
  }

  if (typeof record.startMs === "number" && typeof record.endMs === "number") {
    return {
      startMs: record.startMs,
      endMs: record.endMs,
      ...(title !== undefined ? { title } : {}),
    }
  }

  return undefined
}

/** GET /api/meetings/:id/clips — live clips of a visible meeting. */
export const GET = withAuthz<{ id: string }>("meeting:read", async (_request, ctx, { params }) => {
  const { id } = await params
  const clips = await listClips(clipStoreContext(ctx), id)

  if (!clips) return meetingNotFound()

  const meeting = await ctx.meetings.getMeeting(id, { includeTranscript: false })

  if (!meeting) return meetingNotFound()

  return NextResponse.json({
    clips: clips.map((clip) => toClipWire(clip, canManageClip(ctx, clip, meeting))),
  })
})

/**
 * POST /api/meetings/:id/clips — `{startMs, endMs, title?}` or
 * `{segmentIds, title?}`. Creates the clip (≥ 2 s, ≤ MEETSUM_CLIP_MAX_MS,
 * inside the meeting) and enqueues `clip.render`.
 */
export const POST = withAuthz<{ id: string }>("meeting:write", async (request, ctx, { params }) => {
  const { id } = await params
  const input = parseCreateInput(await request.json().catch(() => undefined))

  if (!input) return jsonError("Provide {startMs, endMs} or {segmentIds}", 400)

  // 20 clip creations per user (or API key) per hour, per instance.
  const limited = rateLimitRequest(
    request,
    CLIP_CREATE_LIMIT,
    `clips_create:${ctx.workspace.id}:${principalKey(ctx)}`
  )

  if (limited.blocked) return limited.blocked

  try {
    const clip = await createClip(clipStoreContext(ctx), id, input)

    try {
      await enqueueMeetSumJob("clip.render", {
        workspaceId: ctx.workspace.id,
        meetingId: id,
        clipId: clip.id,
      })
    } catch (error) {
      // The clip stays `pending` and is still playable in-app via the meeting player.
      console.error("clip.render enqueue failed", (error as Error)?.name ?? error)
    }

    await recordAuditLog({
      ...auditActor(ctx),
      action: "clip.created",
      targetType: "clip",
      targetId: clip.id,
      metadata: { meetingId: id, startMs: clip.startMs, endMs: clip.endMs },
    })

    return NextResponse.json(
      { clip: toClipWire(clip, canManageClip(ctx, clip, { ownerUserId: undefined })) },
      { status: 201 }
    )
  } catch (error) {
    if (error instanceof ClipNotFoundError) return meetingNotFound()
    if (error instanceof ClipQuotaUnavailableError) {
      return NextResponse.json({ error: "quota_unavailable" }, { status: 503, headers: { "Retry-After": "5" } })
    }
    if (error instanceof ClipOwnerRequiredError) {
      return NextResponse.json({ error: "clip_owner_required" }, { status: 403 })
    }
    if (error instanceof ClipLimitError) {
      return NextResponse.json({ error: "clip_limit_reached", scope: error.scope }, { status: 429 })
    }
    if (error instanceof ClipValidationError) {
      return NextResponse.json({ error: error.code }, { status: 400 })
    }
    throw error
  }
})
