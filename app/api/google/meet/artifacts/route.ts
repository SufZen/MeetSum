import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { resolveRequestWorkspaceSubject } from "@/lib/google/request-subject"
import { listMeetArtifacts } from "@/lib/google/meet-artifacts"

export async function GET(request: Request) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const searchParams = new URL(request.url).searchParams
  const resolved = await resolveRequestWorkspaceSubject(
    searchParams.get("subject")
  )

  if ("response" in resolved) return resolved.response

  const { subject } = resolved
  const pageSize = Math.max(1, Math.min(Number(searchParams.get("limit") ?? 20), 50))
  const pageToken = searchParams.get("pageToken") ?? undefined
  const meetingId = searchParams.get("meetingId") ?? undefined

  try {
    const result = await listMeetArtifacts({
      subject,
      limit: pageSize,
      pageToken,
      meetingId,
    })

    return NextResponse.json(result)
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to list Google Meet artifacts"

    return jsonError(
      message,
      500
    )
  }
}
