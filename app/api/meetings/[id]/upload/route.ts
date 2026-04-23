import { NextResponse } from "next/server"

import { createPlatformEvent } from "@/lib/platform/events"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const formData = await request.formData()
  const file = formData.get("file")

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Audio or video file is required" }, { status: 400 })
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
