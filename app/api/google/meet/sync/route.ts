import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { withAuthz } from "@/lib/auth/authz"
import { resolveRequestWorkspaceSubject } from "@/lib/google/request-subject"
import { syncMeetArtifacts } from "@/lib/google/meet-artifacts"
import { createPlatformEvent } from "@/lib/platform/events"

export const POST = withAuthz("meeting:create", async (request, ctx) => {
  const body = (await request.json().catch(() => ({}))) as {
    subject?: string
    limit?: number
  }
  const resolved = resolveRequestWorkspaceSubject(ctx, body.subject)

  if ("response" in resolved) return resolved.response

  const { subject } = resolved

  try {
    const result = await syncMeetArtifacts({
      subject,
      workspaceId: ctx.workspace.id,
      limit: body.limit,
    })

    return NextResponse.json({
      ...result,
      event: createPlatformEvent(
        "google.drive.recording_found",
        {
          subject,
          source: "meet-artifacts",
          discovered: result.discovered,
          artifacts: result.recordings + result.transcripts + result.smartNotes,
        },
        { workspaceId: ctx.workspace.id }
      ),
    })
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Unable to sync Meet artifacts",
      500
    )
  }
})
