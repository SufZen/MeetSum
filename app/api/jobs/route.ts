import { NextResponse } from "next/server"

import { requireAppAccess } from "@/lib/api/responses"
import { meetingRepository } from "@/lib/meetings/store"
import type { JobRecord, JobStatus } from "@/lib/meetings/repository"

function serializeJob(job: JobRecord) {
  const stage =
    typeof job.result.stage === "string"
      ? job.result.stage
      : typeof job.payload.stage === "string"
        ? job.payload.stage
        : job.name

  return {
    ...job,
    stage,
    progress:
      job.status === "completed"
        ? 1
        : job.status === "failed"
          ? 0
          : stage === "audio.transcribe"
            ? 0.35
            : stage === "summary.generate"
              ? 0.65
              : stage === "meeting.index"
                ? 0.85
                : 0.15,
  }
}

export async function GET(request: Request) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const url = new URL(request.url)
  const meetingId = url.searchParams.get("meetingId") ?? undefined
  const status = url.searchParams.get("status") as JobStatus | null

  const jobs = await meetingRepository.listJobs({
      meetingId,
      status: status ?? undefined,
    })

  return NextResponse.json({ jobs: jobs.map(serializeJob) })
}
