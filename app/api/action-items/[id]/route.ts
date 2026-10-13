import { NextResponse } from "next/server"

import {
  auditActor,
  loadVisibleMeeting,
  meetingNotFound,
} from "@/app/api/_lib/meeting-access"
import { jsonError } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { withAuthz } from "@/lib/auth/authz"
import {
  actionItemPatchSchema,
  checkOwnerIds,
  notifyAssignment,
  toRepositoryPatch,
  validationMessage,
} from "@/lib/tasks/api"

function notFound() {
  return jsonError("Action item not found", 404)
}

/**
 * PATCH /api/action-items/:id — body `{ meetingId, ...patch }`.
 *
 * The action item id alone never authorizes anything: the parent meeting
 * is resolved through the scoped repository first (404 when invisible or
 * in another workspace) and the item must belong to that meeting (404
 * otherwise). Only then is the write performed.
 *
 * M5 patch: `title, status, priority, ownerText | ownerParticipantId |
 * ownerUserId (a workspace member), dueOn | dueText (parsed against the
 * meeting start)`. Any content edit marks the item `edited_by_user`, so it
 * survives regeneration (M1); due edits set `dueSource: "user"`.
 */
export const PATCH = withAuthz<{ id: string }>(
  "meeting:write",
  async (request, ctx, { params }) => {
    const { id } = await params
    const raw = (await request.json().catch(() => ({}))) as Record<string, unknown>

    if (typeof raw?.meetingId !== "string" || !raw.meetingId) {
      return jsonError("meetingId is required", 400)
    }

    const parsed = actionItemPatchSchema.safeParse(raw)

    if (!parsed.success) return jsonError(validationMessage(parsed.error), 400)

    const meeting = await loadVisibleMeeting(ctx, parsed.data.meetingId)

    if (!meeting) return meetingNotFound()

    const current = (meeting.summary?.actionItems ?? []).find((item) => item.id === id)

    if (!current) return notFound()

    const owners = await checkOwnerIds(ctx, meeting, parsed.data)

    if (!owners.ok) return jsonError(owners.error, 400)

    const patch = toRepositoryPatch(parsed.data, owners.member)

    let actionItem

    try {
      actionItem = await ctx.meetings.updateActionItem(id, patch)
    } catch {
      return notFound()
    }

    await recordAuditLog({
      ...auditActor(ctx),
      action: "action_item.updated",
      targetType: "action_item",
      targetId: id,
      metadata: { meetingId: meeting.id, fields: Object.keys(patch) },
    })
    await notifyAssignment(ctx, actionItem, meeting.id, current.ownerUserId)

    return NextResponse.json({ actionItem })
  }
)

/**
 * DELETE /api/action-items/:id?meetingId=… — same parent-meeting check as
 * PATCH; an invisible meeting or a foreign item is a 404.
 */
export const DELETE = withAuthz<{ id: string }>(
  "meeting:write",
  async (request, ctx, { params }) => {
    const { id } = await params
    const url = new URL(request.url)
    const body = (await request.json().catch(() => ({}))) as { meetingId?: unknown }
    const meetingId =
      url.searchParams.get("meetingId") ??
      (typeof body?.meetingId === "string" ? body.meetingId : "")

    if (!meetingId) return jsonError("meetingId is required", 400)

    const meeting = await loadVisibleMeeting(ctx, meetingId)

    if (!meeting) return meetingNotFound()

    const current = (meeting.summary?.actionItems ?? []).find((item) => item.id === id)

    if (!current || !(await ctx.meetings.deleteActionItem(id))) return notFound()

    await recordAuditLog({
      ...auditActor(ctx),
      action: "action_item.deleted",
      targetType: "action_item",
      targetId: id,
      metadata: { meetingId: meeting.id, origin: current.origin ?? "ai" },
    })

    return NextResponse.json({ deleted: true, id })
  }
)
