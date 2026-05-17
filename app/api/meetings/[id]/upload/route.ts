import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"
import { meetingRepository } from "@/lib/meetings/store"
import { createPlatformEvent } from "@/lib/platform/events"
import { storeMeetingObject } from "@/lib/storage/object-storage"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) {
    return unauthorized
  }

  const { id } = await params
  const formData = await request.formData()
  const file = formData.get("file")

  if (!(file instanceof File)) {
    return jsonError("Audio or video file is required", 400)
  }

  const contentType = file.type || "application/octet-stream"
  const bytes = Buffer.from(await file.arrayBuffer())
  const stored = await storeMeetingObject({
    meetingId: id,
    filename: file.name,
    contentType,
    bytes,
  })
  const asset = await meetingRepository.createMediaAsset({
    meetingId: id,
    storageKey: stored.key,
    filename: file.name,
    contentType,
    sizeBytes: stored.sizeBytes,
    retention: contentType.startsWith("video/") ? "video" : "audio",
  })
  const job = await enqueueMeetSumJob("media.ingest", {
    meetingId: id,
    assetId: asset.id,
    storageKey: stored.key,
    bucket: stored.bucket,
  })

  return NextResponse.json(
    {
      asset,
      job,
      event: createPlatformEvent("meeting.created", { meetingId: id }),
    },
    { status: 202 }
  )
}
