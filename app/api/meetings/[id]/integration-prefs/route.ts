import { NextResponse } from "next/server"

import { canManageMeeting, withAuthz } from "@/lib/auth/authz"
import { actorUserId, apiError, auditActor, limitFor, readJsonBody } from "@/lib/integrations/core/api"
import { auditIntegration } from "@/lib/integrations/core/audit"
import { getIntegrationStore } from "@/lib/integrations/core/store"
import type { MeetingIntegrationPrefs } from "@/lib/integrations/core/types"

/**
 * /api/meetings/[id]/integration-prefs (M8 A8) `{allowPrivatePush, emailRecap}`.
 * GET: `meeting:read` + visible. PUT: `meeting:write` + visible;
 * `allowPrivatePush` only by the meeting owner (others → 403); `emailRecap`
 * on a private meeting needs `canManageMeeting`. Audits field names only.
 */

function view(meetingId: string, prefs: MeetingIntegrationPrefs | undefined) {
  return {
    meetingId,
    allowPrivatePush: prefs?.allowPrivatePush ?? false,
    emailRecap: prefs?.emailRecap ?? "inherit",
  }
}

export const GET = withAuthz<{ id: string }>("meeting:read", async (_request, ctx, route) => {
  const { id } = await route.params
  const meeting = await ctx.meetings.getMeeting(id)

  if (!meeting) return apiError("not_found", 404)

  const store = await getIntegrationStore()

  return NextResponse.json({ prefs: view(meeting.id, await store.getPrefs(ctx.workspace.id, meeting.id)) })
})

export const PUT = withAuthz<{ id: string }>("meeting:write", async (request, ctx, route) => {
  const limited = limitFor(request, ctx, "integrationsWrite")

  if (limited) return limited

  const { id } = await route.params
  const meeting = await ctx.meetings.getMeeting(id)

  if (!meeting) return apiError("not_found", 404)

  const body = ((await readJsonBody(request)) ?? {}) as { allowPrivatePush?: unknown; emailRecap?: unknown }
  const fields: string[] = []
  const userId = actorUserId(ctx)
  const isOwner = Boolean(userId && meeting.ownerUserId && meeting.ownerUserId === userId && ctx.principal === "user")
  const isPrivate = (meeting.visibility ?? "private") === "private"

  if (body.allowPrivatePush !== undefined) {
    if (typeof body.allowPrivatePush !== "boolean") return apiError("invalid_prefs", 400)
    if (!isOwner) return apiError("owner_only", 403)
    fields.push("allowPrivatePush")
  }
  if (body.emailRecap !== undefined) {
    if (body.emailRecap !== "inherit" && body.emailRecap !== "on" && body.emailRecap !== "off") return apiError("invalid_prefs", 400)
    if (isPrivate && !canManageMeeting(ctx, meeting)) return apiError("forbidden", 403)
    fields.push("emailRecap")
  }
  if (!fields.length) return apiError("invalid_prefs", 400)

  const store = await getIntegrationStore()
  const prefs = await store.upsertPrefs(ctx.workspace.id, meeting.id, {
    ...(typeof body.allowPrivatePush === "boolean"
      ? { allowPrivatePush: body.allowPrivatePush, allowPrivateSetByUserId: body.allowPrivatePush ? userId : null }
      : {}),
    ...(typeof body.emailRecap === "string" ? { emailRecap: body.emailRecap as MeetingIntegrationPrefs["emailRecap"] } : {}),
    ...(userId ? { updatedByUserId: userId } : {}),
  })

  await auditIntegration(auditActor(ctx), "integration.meeting_prefs.updated", { type: "meeting", id: meeting.id }, { fields })

  return NextResponse.json({ prefs: view(meeting.id, prefs) })
})
