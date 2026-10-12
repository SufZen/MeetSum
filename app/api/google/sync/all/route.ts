import { NextResponse } from "next/server"

import { requireAppAccess } from "@/lib/api/responses"
import { resolveRequestWorkspaceSubject } from "@/lib/google/request-subject"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"

export async function POST(request: Request) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const body = (await request.json().catch(() => ({}))) as {
    subject?: string
  }
  const resolved = await resolveRequestWorkspaceSubject(body.subject)

  if ("response" in resolved) return resolved.response

  const { subject } = resolved
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
