import { NextResponse } from "next/server"

import { auditActor } from "@/app/api/_lib/meeting-access"
import { jsonError } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { withAuthz } from "@/lib/auth/authz"
import { isNotFoundError, type ActionItem, type ActionItemPatch } from "@/lib/meetings/repository"
import { emitPlatformEvent } from "@/lib/platform/emit"
import {
  bulkTaskSchema,
  listTaskMembers,
  notifyAssignment,
  validationMessage,
} from "@/lib/tasks/api"

/**
 * POST /api/tasks/bulk — `{ ids (≤ 100), patch: { status | ownerUserId |
 * dueOn | priority } }`. Every id is checked on its own: the scoped
 * repository only updates items of meetings the caller can see, so a
 * foreign or invisible id lands in `notFound` and is never written.
 */
export const POST = withAuthz("meeting:write", async (request, ctx) => {
  const parsed = bulkTaskSchema.safeParse(await request.json().catch(() => ({})))

  if (!parsed.success) return jsonError(validationMessage(parsed.error), 400)

  const { ids, patch: input } = parsed.data
  const patch: ActionItemPatch = {}

  if (input.status !== undefined) patch.status = input.status
  if (input.priority !== undefined) patch.priority = input.priority
  if (input.dueOn !== undefined) patch.dueOn = input.dueOn
  if (input.ownerUserId !== undefined) {
    if (input.ownerUserId === null) {
      patch.ownerUserId = null
      patch.ownerText = null
      patch.ownerParticipantId = null
    } else {
      const member = (await listTaskMembers(ctx.workspace.id)).find(
        (candidate) => candidate.userId === input.ownerUserId
      )

      if (!member) return jsonError("ownerUserId is not a workspace member", 400)
      patch.ownerUserId = member.userId
      patch.ownerText = member.name ?? member.email
      patch.ownerParticipantId = null
    }
  }

  const updated: ActionItem[] = []
  const notFound: string[] = []
  const reassigning = typeof input.ownerUserId === "string"

  for (const id of [...new Set(ids)]) {
    // The previous owner is captured before the write: only a real change
    // of assignee notifies (a status-only update never does).
    const previous = reassigning ? await ctx.meetings.getActionItem(id) : undefined
    let item: ActionItem

    try {
      item = await ctx.meetings.updateActionItem(id, patch)
    } catch (error) {
      // Only "not visible / does not exist" is a not-found; storage errors
      // surface as 500s.
      if (!isNotFoundError(error)) {
        console.error("[tasks] bulk update failed", error instanceof Error ? error.name : "error")
        return jsonError("Failed to update tasks", 500)
      }
      notFound.push(id)
      continue
    }

    updated.push(item)
    await recordAuditLog({
      ...auditActor(ctx),
      action: "action_item.updated",
      targetType: "action_item",
      targetId: id,
      metadata: { meetingId: item.meetingId ?? null, fields: Object.keys(patch), bulk: true },
    })
    await emitPlatformEvent({ workspaceId: ctx.workspace.id, repo: ctx.meetings }, "action_item.updated", { meetingId: item.meetingId ?? null, actionItemId: id, changed: Object.keys(patch) }).catch(() => {})
    if (reassigning && item.meetingId && previous?.ownerUserId !== input.ownerUserId) {
      const meeting = await ctx.meetings.getMeeting(item.meetingId, { includeTranscript: false })

      if (meeting) await notifyAssignment(ctx, item, meeting, previous?.ownerUserId)
    }
  }

  return NextResponse.json({ updated, notFound })
})
