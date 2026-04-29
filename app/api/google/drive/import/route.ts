import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { getWorkspaceSubject } from "@/lib/google/auth"
import { importDriveRecordings, validateDriveImportFileIds } from "@/lib/google/services"

export async function POST(request: Request) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

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

  try {
    const result = await importDriveRecordings(
      body.subject ?? getWorkspaceSubject(),
      fileIds
    )

    return NextResponse.json(result, { status: 202 })
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Unable to import Drive recordings",
      500
    )
  }
}
