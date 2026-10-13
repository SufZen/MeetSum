import { NextResponse } from "next/server"

import {
  loadVisibleMeeting,
  meetingNotFound,
} from "@/app/api/_lib/meeting-access"
import { jsonError } from "@/lib/api/responses"
import { withAuthz } from "@/lib/auth/authz"
import { requestMeetingReindex } from "@/lib/search/index-trigger"

export const POST = withAuthz<{ id: string }>(
  "meeting:write",
  async (request, ctx, { params }) => {
    const { id } = await params
    const { contextId } = (await request.json().catch(() => ({}))) as {
      contextId?: string
    }

    if (!contextId) {
      return jsonError("contextId is required", 400)
    }

    if (!(await loadVisibleMeeting(ctx, id))) return meetingNotFound()

    // Child-id IDOR guard: the room must belong to the caller's workspace.
    const contexts = await ctx.meetings.listContexts()

    if (!contexts.some((context) => context.id === contextId)) {
      return jsonError("Room not found", 404)
    }

    try {
      const meeting = await ctx.meetings.linkMeetingContext(id, contextId)

      await requestMeetingReindex({ workspaceId: ctx.workspace.id, meetingId: id, reason: "contexts" })

      return NextResponse.json({ meeting })
    } catch (error) {
      return jsonError(
        error instanceof Error ? error.message : "Unable to link context",
        404
      )
    }
  }
)
