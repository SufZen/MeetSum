import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { meetingRepository } from "@/lib/meetings/store"

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) {
    return unauthorized
  }

  const { id } = await params
  const body = (await request.json()) as {
    title?: string
    owner?: string
    status?: "open" | "done"
    dueDate?: string
    priority?: "low" | "normal" | "high" | "urgent"
  }

  try {
    const actionItem = await meetingRepository.updateActionItem(id, body)

    return NextResponse.json({ actionItem })
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Unable to update action item",
      404
    )
  }
}
