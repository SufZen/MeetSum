import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import {
  buildGoogleSyncPlan,
  type GoogleSyncSource,
} from "@/lib/google/workspace"
import { getWorkspaceSubject } from "@/lib/google/auth"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"
import { createPlatformEvent } from "@/lib/platform/events"

const eventBySource: Record<
  GoogleSyncSource,
  Parameters<typeof createPlatformEvent>[0]
> = {
  calendar: "google.calendar.event_changed",
  gmail: "google.gmail.thread_matched",
  drive: "google.drive.recording_found",
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ source: string }> }
) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) {
    return unauthorized
  }

  const { source } = await params
  const { subject = getWorkspaceSubject() } = (await request
    .json()
    .catch(() => ({}))) as {
    subject?: string
  }

  if (!["calendar", "gmail", "drive"].includes(source)) {
    return jsonError("Unsupported Google source", 400)
  }

  const syncSource = source as GoogleSyncSource
  const syncItem = buildGoogleSyncPlan(subject).find(
    (item) => item.source === syncSource
  )
  const job = await enqueueMeetSumJob(`google.${syncSource}.poll`, {
    subject,
    source: syncSource,
  })

  return NextResponse.json({
    sync: {
      ...syncItem,
      status: "queued",
    },
    job,
    event: createPlatformEvent(eventBySource[syncSource], {
      subject,
      source: syncSource,
    }),
  })
}
