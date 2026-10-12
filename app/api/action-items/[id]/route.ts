import { NextResponse } from "next/server"

import {
  loadVisibleMeeting,
  meetingNotFound,
} from "@/app/api/_lib/meeting-access"
import { jsonError } from "@/lib/api/responses"
import { withAuthz } from "@/lib/auth/authz"

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
 */
export const PATCH = withAuthz<{ id: string }>(
  "meeting:write",
  async (request, ctx, { params }) => {
    const { id } = await params
    const body = (await request.json().catch(() => ({}))) as {
      meetingId?: unknown
      title?: string
      owner?: string
      status?: "open" | "done"
      dueDate?: string
      priority?: "low" | "normal" | "high" | "urgent"
    }
    const meetingId = typeof body.meetingId === "string" ? body.meetingId : ""

    if (!meetingId) return jsonError("meetingId is required", 400)

    const meeting = await loadVisibleMeeting(ctx, meetingId)

    if (!meeting) return meetingNotFound()

    const belongs = (meeting.summary?.actionItems ?? []).some(
      (item) => item.id === id
    )

    if (!belongs) return notFound()

    const patch = {
      title: body.title,
      owner: body.owner,
      status: body.status,
      dueDate: body.dueDate,
      priority: body.priority,
    }
    const definedPatch = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined)
    ) as typeof patch

    try {
      const actionItem = await ctx.meetings.updateActionItem(id, definedPatch)

      return NextResponse.json({ actionItem })
    } catch (error) {
      return jsonError(
        error instanceof Error ? error.message : "Unable to update action item",
        404
      )
    }
  }
)
