import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { withAuthz } from "@/lib/auth/authz"

/**
 * PATCH /api/action-items/:id — the scoped repository joins the action item
 * to a meeting visible to the caller; anything else is reported as 404.
 */
export const PATCH = withAuthz<{ id: string }>(
  "meeting:write",
  async (request, ctx, { params }) => {
    const { id } = await params
    const body = (await request.json().catch(() => ({}))) as {
      title?: string
      owner?: string
      status?: "open" | "done"
      dueDate?: string
      priority?: "low" | "normal" | "high" | "urgent"
    }

    try {
      const actionItem = await ctx.meetings.updateActionItem(id, body)

      return NextResponse.json({ actionItem })
    } catch (error) {
      return jsonError(
        error instanceof Error ? error.message : "Unable to update action item",
        404
      )
    }
  }
)
