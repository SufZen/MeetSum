import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"
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

export const GET = withAuthz("jobs:read", async (request, ctx) => {
  const url = new URL(request.url)
  const meetingId = url.searchParams.get("meetingId") ?? undefined
  const status = url.searchParams.get("status") as JobStatus | null

  const jobs = await ctx.meetings.listJobs({
    meetingId,
    status: status ?? undefined,
  })

  return NextResponse.json({ jobs: jobs.map(serializeJob) })
})
