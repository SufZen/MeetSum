import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { getWorkspaceSubject } from "@/lib/google/auth"
import { listDriveRecordings } from "@/lib/google/services"

export async function GET(request: Request) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const searchParams = new URL(request.url).searchParams
  const limit = Number(searchParams.get("limit") ?? 25)
  const cursor = searchParams.get("cursor") ?? undefined
  const query = searchParams.get("query") ?? undefined
  const includeImported = searchParams.get("includeImported") === "true"
  const subject = searchParams.get("subject") ?? getWorkspaceSubject()

  try {
    const result = await listDriveRecordings(subject, {
      limit,
      cursor,
      query,
      includeImported,
    })

    return NextResponse.json(result)
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Unable to list Drive recordings",
      500
    )
  }
}
