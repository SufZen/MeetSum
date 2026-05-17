import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { getWorkspaceSubject } from "@/lib/google/auth"
import { syncMeetArtifacts } from "@/lib/google/meet-artifacts"
import { createPlatformEvent } from "@/lib/platform/events"

export async function POST(request: Request) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const body = (await request.json().catch(() => ({}))) as {
    subject?: string
    limit?: number
  }
  const subject = body.subject ?? getWorkspaceSubject()

  try {
    const result = await syncMeetArtifacts({
      subject,
      limit: body.limit,
    })

    return NextResponse.json({
      ...result,
      event: createPlatformEvent("google.drive.recording_found", {
        subject,
        source: "meet-artifacts",
        discovered: result.discovered,
        artifacts: result.recordings + result.transcripts + result.smartNotes,
      }),
    })
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Unable to sync Meet artifacts",
      500
    )
  }
}
