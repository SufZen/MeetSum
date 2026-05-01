import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"
import { meetingRepository } from "@/lib/meetings/store"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const { id } = await params
  const meeting = await meetingRepository.getMeeting(id)

  if (!meeting) return jsonError("Meeting not found", 404)

  const mediaAsset = meeting.mediaAssets?.find((asset) => asset.storageKey)
  const hasTranscript = Boolean(meeting.transcript?.length)

  if (mediaAsset) {
    const job = await enqueueMeetSumJob("media.ingest", {
      meetingId: id,
      assetId: mediaAsset.id,
      storageKey: mediaAsset.storageKey,
      stage: "audio.transcribe",
      source: "manual-process",
    })

    return NextResponse.json(
      {
        job,
        mode: "media",
        message: "Processing queued from the attached recording.",
      },
      { status: 202 }
    )
  }

  if (hasTranscript) {
    const job = await enqueueMeetSumJob("meeting.summarize", {
      meetingId: id,
      mode: "summary",
      stage: "summary.generate",
      source: "manual-process",
    })

    return NextResponse.json(
      {
        job,
        mode: "transcript",
        message: "Summary generation queued from the existing transcript.",
      },
      { status: 202 }
    )
  }

  return NextResponse.json(
    {
      error:
        "This meeting has no recording or transcript yet. Import a Drive recording, sync Meet artifacts, or upload audio before processing.",
      nextActions: ["find_drive_recordings", "upload_recording", "sync_meet_artifacts"],
    },
    { status: 409 }
  )
}
