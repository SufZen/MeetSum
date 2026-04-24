import { NextResponse } from "next/server"

import { requireAppAccess } from "@/lib/api/responses"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"

export async function POST(request: Request) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const { subject = "info@realization.co.il" } = (await request
    .json()
    .catch(() => ({}))) as { subject?: string }
  const jobs = await Promise.all([
    enqueueMeetSumJob("google.calendar.poll", { subject, source: "calendar" }),
    enqueueMeetSumJob("google.drive.poll", { subject, source: "drive" }),
    enqueueMeetSumJob("google.gmail.poll", { subject, source: "gmail" }),
  ])

  return NextResponse.json({ jobs }, { status: 202 })
}
