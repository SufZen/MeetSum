import { NextResponse } from "next/server"

import { requireAppAccess } from "@/lib/api/responses"
import { getWorkspaceSubject } from "@/lib/google/auth"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"

export async function POST(request: Request) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const { subject = getWorkspaceSubject() } = (await request
    .json()
    .catch(() => ({}))) as { subject?: string }
  const jobs = await Promise.all([
    enqueueMeetSumJob("google.calendar.poll", { subject, source: "calendar" }),
  ])

  return NextResponse.json(
    {
      jobs,
      skipped: {
        drive:
          "Drive media import is manual-only. Use /api/google/drive/recordings and /api/google/drive/import.",
        gmail: "Gmail context sync is deferred.",
      },
    },
    { status: 202 }
  )
}
