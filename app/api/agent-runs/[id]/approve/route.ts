import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { meetingRepository } from "@/lib/meetings/store"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const { id } = await params

  try {
    const run = await meetingRepository.approveAgentRun(id)

    return NextResponse.json({ run })
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Unable to approve agent run",
      404
    )
  }
}
