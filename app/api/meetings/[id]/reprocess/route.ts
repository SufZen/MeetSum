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
