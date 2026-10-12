import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { withAuthz } from "@/lib/auth/authz"
import type { JobRecord } from "@/lib/meetings/repository"

function serializeJob(job: JobRecord) {
  const stage =
    typeof job.result.stage === "string"
      ? job.result.stage
      : typeof job.payload.stage === "string"
        ? job.payload.stage
        : job.name

  return { ...job, stage }
}

export const GET = withAuthz<{ id: string }>(
  "jobs:read",
  async (_request, ctx, { params }) => {
    const { id } = await params
    const job = await ctx.meetings.getJob(id)

    if (!job) {
      return jsonError("Job not found", 404)
    }

    return NextResponse.json({ job: serializeJob(job) })
  }
)
