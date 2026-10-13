import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { withAuthz } from "@/lib/auth/authz"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"
import type { MeetSumJobName } from "@/lib/jobs/queue"

export const POST = withAuthz<{ id: string }>(
  "jobs:write",
  async (_request, ctx, { params }) => {
    const { id } = await params
    // ctx.meetings only returns jobs of this workspace (404 otherwise).
    const existing = await ctx.meetings.getJob(id)

    if (!existing) return jsonError("Job not found", 404)

    const job = await enqueueMeetSumJob(existing.name as MeetSumJobName, {
      ...existing.payload,
      meetingId: existing.meetingId,
      // Always the caller's workspace, never a value read from the payload.
      workspaceId: ctx.workspace.id,
      retryOfJobId: existing.id,
    })

    return NextResponse.json({ job }, { status: 202 })
  }
)
