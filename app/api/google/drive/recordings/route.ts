import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { withAuthz } from "@/lib/auth/authz"
import { resolveRequestWorkspaceSubject } from "@/lib/google/request-subject"
import { listDriveRecordings } from "@/lib/google/services"

export const GET = withAuthz("meeting:create", async (request, ctx) => {
  const searchParams = new URL(request.url).searchParams
  const limit = Number(searchParams.get("limit") ?? 25)
  const cursor = searchParams.get("cursor") ?? undefined
  const query = searchParams.get("query") ?? undefined
  const includeImported = searchParams.get("includeImported") === "true"
  const resolved = resolveRequestWorkspaceSubject(ctx, searchParams.get("subject"))

  if ("response" in resolved) return resolved.response

  try {
    const result = await listDriveRecordings(
      { subject: resolved.subject, workspaceId: ctx.workspace.id },
      { limit, cursor, query, includeImported }
    )

    return NextResponse.json(result)
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Unable to list Drive recordings",
      500
    )
  }
})
