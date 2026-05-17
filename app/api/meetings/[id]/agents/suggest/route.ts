import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { buildMeetingAgentSuggestions } from "@/lib/agents/suggestions"
import { meetingRepository } from "@/lib/meetings/store"

const targets = ["realizeos", "n8n", "mcp", "webhook"]

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const { id } = await params
  const body = await request.json().catch(() => ({}))

  try {
    if (!body.target && !body.payload) {
      const meeting = await meetingRepository.getMeeting(id)

      if (!meeting) {
        return jsonError("Meeting not found", 404)
      }

      const suggestions = await Promise.all(
        buildMeetingAgentSuggestions(meeting).map((suggestion) =>
          meetingRepository.createSuggestedAgentRun({
            meetingId: id,
            target: suggestion.target,
            payload: suggestion.payload,
          })
        )
      )

      return NextResponse.json({ suggestions })
    }

    const target = targets.includes(body.target) ? body.target : "realizeos"
    const run = await meetingRepository.createSuggestedAgentRun({
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
