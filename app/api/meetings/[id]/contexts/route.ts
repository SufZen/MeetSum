import { NextResponse } from "next/server"

import { jsonError, requireApiKey } from "@/lib/api/responses"
import { meetingRepository } from "@/lib/meetings/store"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = requireApiKey(request)

  if (unauthorized) {
    return unauthorized
  }

  const { id } = await params
  const { contextId } = (await request.json()) as { contextId?: string }

  if (!contextId) {
    return jsonError("contextId is required", 400)
  }

  try {
    const meeting = await meetingRepository.linkMeetingContext(id, contextId)

    return NextResponse.json({ meeting })
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Unable to link context",
      404
    )
  }
}
