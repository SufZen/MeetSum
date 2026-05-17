import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import type { JobRecord } from "@/lib/meetings/repository"
import { meetingRepository } from "@/lib/meetings/store"

function serializeJob(job: JobRecord) {
  const stage =
    typeof job.result.stage === "string"
      ? job.result.stage
      : typeof job.payload.stage === "string"
        ? job.payload.stage
        : job.name

  return { ...job, stage }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) {
    return unauthorized
  }

  const { id } = await params
  const job = await meetingRepository.getJob(id)

  if (!job) {
    return jsonError("Job not found", 404)
  }

  return NextResponse.json({ job: serializeJob(job) })
}
