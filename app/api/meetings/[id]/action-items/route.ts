import { NextResponse } from "next/server"

import {
  auditActor,
  creatorUserId,
  loadVisibleMeeting,
  meetingNotFound,
} from "@/app/api/_lib/meeting-access"
import { jsonError } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { withAuthz } from "@/lib/auth/authz"
import { isNotFoundError } from "@/lib/meetings/repository"
import {
  checkOwnerIds,
  createActionItemSchema,
  notifyAssignment,
  validationMessage,
} from "@/lib/tasks/api"

/** GET /api/meetings/:id/action-items — the meeting's action items. */
export const GET = withAuthz<{ id: string }>(
  "meeting:read",
  async (_request, ctx, { params }) => {
    const { id } = await params
    const meeting = await loadVisibleMeeting(ctx, id)

    if (!meeting) return meetingNotFound()

    return NextResponse.json({ actionItems: meeting.summary?.actionItems ?? [] })
  }
)

/**
 * POST /api/meetings/:id/action-items — a user task ("+ משימה"): origin
 * `user`, `edited_by_user`, so regeneration never touches it. A due phrase
 * is parsed against the meeting start.
 */
export const POST = withAuthz<{ id: string }>(
  "meeting:write",
  async (request, ctx, { params }) => {
    const { id } = await params
    const meeting = await loadVisibleMeeting(ctx, id)

    if (!meeting) return meetingNotFound()

    const parsed = createActionItemSchema.safeParse(
      await request.json().catch(() => ({}))
    )

    if (!parsed.success) return jsonError(validationMessage(parsed.error), 400)

    const owners = await checkOwnerIds(ctx, meeting, parsed.data)

    if (!owners.ok) return jsonError(owners.error, 400)

    const input = {
      ...parsed.data,
      ownerText:
        parsed.data.ownerText ??
        (owners.member ? (owners.member.name ?? owners.member.email) : undefined),
    }

    let actionItem

    try {
      actionItem = await ctx.meetings.createActionItem(id, input, {
        userId: creatorUserId(ctx),
      })
    } catch (error) {
      if (isNotFoundError(error)) return meetingNotFound()
      console.error("[action-items] create failed", error instanceof Error ? error.name : "error")
      return jsonError("Failed to create action item", 500)
    }

    await recordAuditLog({
      ...auditActor(ctx),
      action: "action_item.created",
      targetType: "action_item",
      targetId: actionItem.id,
      metadata: { meetingId: id },
    })
    await notifyAssignment(ctx, actionItem, id, undefined)

    return NextResponse.json({ actionItem }, { status: 201 })
  }
)
