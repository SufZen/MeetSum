import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
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
  const target = targets.includes(body.target) ? body.target : "realizeos"

  try {
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
