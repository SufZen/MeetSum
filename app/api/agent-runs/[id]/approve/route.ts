import { NextResponse } from "next/server"

import {
  loadVisibleMeeting,
  meetingNotFound,
} from "@/app/api/_lib/meeting-access"
import { jsonError } from "@/lib/api/responses"
import { withAuthz } from "@/lib/auth/authz"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"

/**
 * POST /api/agent-runs/:id/approve — body `{ meetingId }` (or `?meetingId=`).
 *
 * The run id alone never authorizes anything: the parent meeting is
 * resolved through the scoped repository (404 when invisible or in another
 * workspace) and the run must belong to it (404 otherwise).
 */
export const POST = withAuthz<{ id: string }>(
  "meeting:write",
  async (request, ctx, { params }) => {
    const { id } = await params
    const body = (await request.json().catch(() => ({}))) as {
      meetingId?: unknown
    }
    const meetingId =
      (typeof body.meetingId === "string" ? body.meetingId : "") ||
      new URL(request.url).searchParams.get("meetingId") ||
      ""

    if (!meetingId) return jsonError("meetingId is required", 400)

    const meeting = await loadVisibleMeeting(ctx, meetingId)

    if (!meeting) return meetingNotFound()

    if (!(meeting.suggestedAgentRuns ?? []).some((run) => run.id === id)) {
      return jsonError("Agent run not found", 404)
    }

    try {
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
