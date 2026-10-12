import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { withAuthz } from "@/lib/auth/authz"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"

export const POST = withAuthz<{ id: string }>(
  "meeting:write",
  async (_request, ctx, { params }) => {
    const { id } = await params

    try {
      // Scoped repository: runs of meetings the caller cannot see -> throws.
      const run = await ctx.meetings.approveAgentRun(id)
      const job =
        run.target === "realizeos"
          ? await enqueueMeetSumJob("realizeos.export", {
              meetingId: run.meetingId,
              suggestionId: run.id,
              workspaceId: ctx.workspace.id,
            })
          : undefined

      return NextResponse.json({ run, job })
    } catch (error) {
      return jsonError(
        error instanceof Error ? error.message : "Unable to approve agent run",
        404
      )
    }
  }
)
