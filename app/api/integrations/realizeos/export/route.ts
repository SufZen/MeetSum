import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { withAuthz } from "@/lib/auth/authz"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"
import { createPlatformEvent } from "@/lib/platform/events"

export const POST = withAuthz("meeting:write", async (request, ctx) => {
  const { meetingId, contextId } = (await request.json().catch(() => ({}))) as {
    meetingId?: string
    contextId?: string
  }

  if (!meetingId) {
    return jsonError("meetingId is required", 400)
  }

  if (!(await ctx.meetings.getMeeting(meetingId))) {
    return jsonError("Meeting not found", 404)
  }

  try {
    const intelligence =
      (await ctx.meetings.getMeetingIntelligence(meetingId)) ??
      (await ctx.meetings.runMeetingIntelligence(meetingId))
    const suggestion = await ctx.meetings.createSuggestedAgentRun({
      meetingId,
      target: "realizeos",
      payload: {
        contextId,
        intelligence,
      },
    })
    const job = await enqueueMeetSumJob("realizeos.export", {
      meetingId,
      workspaceId: ctx.workspace.id,
      contextId,
      suggestionId: suggestion.id,
    })
    await recordAuditLog({
      ...ctx.audit,
      action: "realizeos.export.queued",
      targetType: "meeting",
      targetId: meetingId,
      metadata: {
        contextId,
        suggestionId: suggestion.id,
        jobId: job.id,
      },
    })

    return NextResponse.json({
      suggestion,
      job,
      event: createPlatformEvent(
        "agent.triggered",
        { agent: "realizeos-export", meetingId },
        { workspaceId: ctx.workspace.id }
      ),
    })
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Unable to create RealizeOS export",
      404
    )
  }
})
