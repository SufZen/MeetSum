import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"
import { meetingRepository } from "@/lib/meetings/store"
import type { MeetSumJobName } from "@/lib/jobs/queue"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const { id } = await params
  const existing = await meetingRepository.getJob(id)

  if (!existing) return jsonError("Job not found", 404)

  const job = await enqueueMeetSumJob(existing.name as MeetSumJobName, {
    ...existing.payload,
    meetingId: existing.meetingId,
    retryOfJobId: existing.id,
  })

  return NextResponse.json({ job }, { status: 202 })
}
