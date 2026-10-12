import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { toRepoScope, withAuthz } from "@/lib/auth/authz"
import { resolveRequestWorkspaceSubject } from "@/lib/google/request-subject"
import { listMeetArtifacts } from "@/lib/google/meet-artifacts"

export const GET = withAuthz("integrations:manage", async (request, ctx) => {
  const searchParams = new URL(request.url).searchParams
  const resolved = resolveRequestWorkspaceSubject(ctx, searchParams.get("subject"))

  if ("response" in resolved) return resolved.response

  const { subject } = resolved
  const pageSize = Math.max(1, Math.min(Number(searchParams.get("limit") ?? 20), 50))
  const pageToken = searchParams.get("pageToken") ?? undefined
  const meetingId = searchParams.get("meetingId") ?? undefined

  // A meeting filter must name a meeting this principal can see.
  if (meetingId && !(await ctx.meetings.getMeeting(meetingId))) {
    return jsonError("Meeting not found", 404)
  }

  try {
    const result = await listMeetArtifacts({
      subject,
      workspaceId: ctx.workspace.id,
      limit: pageSize,
      pageToken,
      meetingId,
      scope: toRepoScope(ctx),
    })

    return NextResponse.json(result)
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to list Google Meet artifacts"

    return jsonError(message, 500)
  }
})
