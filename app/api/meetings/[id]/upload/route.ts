import { NextResponse } from "next/server"

import { jsonError, requireApiKey } from "@/lib/api/responses"
import { createPlatformEvent } from "@/lib/platform/events"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = requireApiKey(request)

  if (unauthorized) {
    return unauthorized
  }

  const { id } = await params
  const formData = await request.formData()
  const file = formData.get("file")

  if (!(file instanceof File)) {
    return jsonError("Audio or video file is required", 400)
  }

  return NextResponse.json({
    asset: {
      meetingId: id,
      filename: file.name,
      contentType: file.type || "application/octet-stream",
      size: file.size,
      retention: "audio",
      nextStatus: "media_uploaded",
    },
    event: createPlatformEvent("meeting.created", { meetingId: id }),
  })
}
