import { NextResponse } from "next/server"

import { auditActor } from "@/app/api/_lib/meeting-access"
import { jsonError } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { withAuthz } from "@/lib/auth/authz"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"
import { requestMeetingReindex } from "@/lib/search/index-trigger"
import { requestWorkspaceIndexing } from "@/lib/search/index-sweep"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * POST /api/admin/search/reindex `{meetingId?}` (docs/parity/m6.md A7;
 * owner: Package A): re-index one visible meeting, else the whole
 * workspace. Audited as `search.reindex.requested` with ids only.
 */
export const POST = withAuthz("settings:write", async (request, ctx) => {
  const rateLimit = await rateLimitRequest(request, RATE_LIMIT_PRESETS.admin)

  if (rateLimit.blocked) return rateLimit.blocked

  const body = (await request.json().catch(() => ({}))) as unknown
  const raw = body && typeof body === "object" ? (body as { meetingId?: unknown }).meetingId : undefined

  if (raw !== undefined && raw !== null && (typeof raw !== "string" || !raw.trim())) {
    return jsonError("meetingId must be a non-empty string", 400)
  }

  const meetingId = typeof raw === "string" ? raw.trim() : undefined

  if (meetingId) {
    // 404 for meetings this caller cannot see (no existence hints).
    const meeting = await ctx.meetings.getMeeting(meetingId, { includeTranscript: false })

    if (!meeting) return jsonError("Meeting not found", 404)

    await requestMeetingReindex({ workspaceId: ctx.workspace.id, meetingId: meeting.id, reason: "admin" })
    await recordAuditLog({
      ...auditActor(ctx),
      action: "search.reindex.requested",
      targetType: "meeting",
      targetId: meeting.id,
      metadata: { scope: "meeting" },
    })

    return NextResponse.json(
      { scope: "meeting", meetingId: meeting.id, meetings: 1 },
      { status: 202, headers: rateLimit.headers }
    )
  }

  const result = await requestWorkspaceIndexing(ctx.workspace.id)

  await recordAuditLog({
    ...auditActor(ctx),
    action: "search.reindex.requested",
    targetType: "workspace",
    targetId: ctx.workspace.id,
    metadata: { scope: "workspace", meetings: result.meetings },
  })

  return NextResponse.json({ scope: "workspace", ...result }, { status: 202, headers: rateLimit.headers })
})
