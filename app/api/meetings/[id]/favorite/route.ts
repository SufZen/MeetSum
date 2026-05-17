import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { meetingRepository } from "@/lib/meetings/store"

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const { id } = await params
  const body = await request.json().catch(() => ({}))

  if (typeof body.favorite !== "boolean") {
    return jsonError("favorite boolean is required", 400)
  }

  try {
    const meeting = await meetingRepository.updateMeetingFavorite(
      id,
      body.favorite
    )

    return NextResponse.json({ meeting })
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Unable to update favorite",
      404
    )
  }
}
