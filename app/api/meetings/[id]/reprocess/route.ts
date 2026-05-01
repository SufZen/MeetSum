import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"
import { meetingRepository } from "@/lib/meetings/store"
import { createPlatformEvent } from "@/lib/platform/events"

const modes = ["full", "summary", "tasks", "transcript-cleanup"] as const
type ReprocessMode = (typeof modes)[number]

function parseMode(value: unknown): ReprocessMode {
  return modes.includes(value as ReprocessMode)
    ? (value as ReprocessMode)
    : "full"
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const { id } = await params
  const meeting = await meetingRepository.getMeeting(id)

  if (!meeting) return jsonError("Meeting not found", 404)

  const body = (await request.json().catch(() => ({}))) as { mode?: unknown }
  const mode = parseMode(body.mode)
  const hasMedia = Boolean(meeting.mediaAssets?.some((asset) => asset.storageKey))
  const hasTranscript = Boolean(meeting.transcript?.length)

  if (mode === "full" && !hasMedia) {
    return NextResponse.json(
      {
        error:
          "This meeting has no recording attached yet. Import a Drive recording, sync Meet artifacts, or upload audio before full reprocessing.",
        nextActions: ["find_drive_recordings", "upload_recording", "sync_meet_artifacts"],
      },
      { status: 409 }
    )
  }

  if (mode !== "full" && !hasTranscript) {
    return NextResponse.json(
      {
        error:
          "This meeting has no transcript yet. Attach or import a recording before rerunning summary or task extraction.",
        nextActions: ["find_drive_recordings", "upload_recording", "sync_meet_artifacts"],
      },
      { status: 409 }
    )
  }

  const job = await enqueueMeetSumJob(mode === "full" ? "media.ingest" : "meeting.summarize", {
    meetingId: id,
    mode,
    stage: mode,
  })

  return NextResponse.json(
    {
      job,
      mode,
      event: createPlatformEvent("summary.created", { meetingId: id, mode }),
    },
    { status: 202 }
  )
}
