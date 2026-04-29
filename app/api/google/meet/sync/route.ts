import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { getWorkspaceSubject } from "@/lib/google/auth"
import { createPlatformEvent } from "@/lib/platform/events"

export async function POST(request: Request) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const body = (await request.json().catch(() => ({}))) as { subject?: string }
  const subject = body.subject ?? getWorkspaceSubject()

  try {
    return NextResponse.json({
      subject,
      status: "queued",
      mode: "google-artifacts-first",
      message:
        "Meet artifact discovery is enabled. Use /api/google/meet/artifacts to inspect conference records; Drive import remains operator-selected.",
      event: createPlatformEvent("google.drive.recording_found", {
        subject,
        source: "meet-artifacts",
      }),
    })
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Unable to sync Meet artifacts",
      500
    )
  }
}
