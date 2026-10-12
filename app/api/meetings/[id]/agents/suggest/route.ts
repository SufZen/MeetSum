import { NextResponse } from "next/server"

import {
  loadVisibleMeeting,
  meetingNotFound,
} from "@/app/api/_lib/meeting-access"
import { buildMeetingAgentSuggestions } from "@/lib/agents/suggestions"
import { jsonError } from "@/lib/api/responses"
import { withAuthz } from "@/lib/auth/authz"

const targets = ["realizeos", "n8n", "mcp", "webhook"]

export const POST = withAuthz<{ id: string }>(
  "meeting:write",
  async (request, ctx, { params }) => {
    const { id } = await params
    const meeting = await loadVisibleMeeting(ctx, id)

    if (!meeting) return meetingNotFound()

    const body = await request.json().catch(() => ({}))

    try {
      if (!body.target && !body.payload) {
        const suggestions = await Promise.all(
          buildMeetingAgentSuggestions(meeting).map((suggestion) =>
            ctx.meetings.createSuggestedAgentRun({
              meetingId: id,
              target: suggestion.target,
              payload: suggestion.payload,
            })
          )
        )

        return NextResponse.json({ suggestions })
      }

      const target = targets.includes(body.target) ? body.target : "realizeos"
      const run = await ctx.meetings.createSuggestedAgentRun({
        meetingId: id,
        target,
        payload:
          typeof body.payload === "object" && body.payload
            ? body.payload
            : { intent: "create_followup_context" },
      })

      return NextResponse.json({ run })
    } catch (error) {
      return jsonError(
        error instanceof Error ? error.message : "Unable to suggest agent run",
        400
      )
    }
  }
)
