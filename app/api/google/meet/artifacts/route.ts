import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { getWorkspaceSubject } from "@/lib/google/auth"
import { listMeetArtifacts } from "@/lib/google/meet-artifacts"

export async function GET(request: Request) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const searchParams = new URL(request.url).searchParams
  const subject = searchParams.get("subject") ?? getWorkspaceSubject()
  const pageSize = Math.max(1, Math.min(Number(searchParams.get("limit") ?? 20), 50))
  const pageToken = searchParams.get("pageToken") ?? undefined

  try {
    const result = await listMeetArtifacts({
      subject,
      limit: pageSize,
      pageToken,
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
