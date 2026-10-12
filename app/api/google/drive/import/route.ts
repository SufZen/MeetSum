import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { withAuthz } from "@/lib/auth/authz"
import { resolveRequestWorkspaceSubject } from "@/lib/google/request-subject"
import { importDriveRecordings, validateDriveImportFileIds } from "@/lib/google/services"

export const POST = withAuthz("meeting:create", async (request, ctx) => {
  let body: { fileIds?: unknown; subject?: string }

  try {
    body = await request.json()
  } catch {
    return jsonError("Invalid Drive import payload", 400)
  }

  let fileIds: string[]

  try {
    fileIds = validateDriveImportFileIds(body.fileIds)
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Invalid Drive file selection",
      400
    )
  }

  const resolved = resolveRequestWorkspaceSubject(ctx, body.subject)

  if ("response" in resolved) return resolved.response

  try {
    const result = await importDriveRecordings(
      { subject: resolved.subject, workspaceId: ctx.workspace.id },
      fileIds,
      { ownerUserId: ctx.user?.id ?? ctx.apiKey?.createdByUserId }
    )

    return NextResponse.json(result, { status: 202 })
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Unable to import Drive recordings",
      500
    )
  }
})
