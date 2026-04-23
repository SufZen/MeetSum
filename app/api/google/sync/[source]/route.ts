import { NextResponse } from "next/server"

import {
  buildGoogleSyncPlan,
  type GoogleSyncSource,
} from "@/lib/google/workspace"
import { createPlatformEvent } from "@/lib/platform/events"

const eventBySource: Record<GoogleSyncSource, Parameters<typeof createPlatformEvent>[0]> = {
  calendar: "google.calendar.event_changed",
  gmail: "google.gmail.thread_matched",
  drive: "google.drive.recording_found",
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ source: string }> },
) {
  const { source } = await params
  const { subject = "admin@example.com" } = (await request.json().catch(() => ({}))) as {
    subject?: string
  }

  if (!["calendar", "gmail", "drive"].includes(source)) {
    return NextResponse.json({ error: "Unsupported Google source" }, { status: 400 })
  }

  const syncSource = source as GoogleSyncSource
  const syncItem = buildGoogleSyncPlan(subject).find(
    (item) => item.source === syncSource,
  )

  return NextResponse.json({
    sync: {
      ...syncItem,
      status: "queued",
    },
    event: createPlatformEvent(eventBySource[syncSource], {
      subject,
      source: syncSource,
    }),
  })
}
