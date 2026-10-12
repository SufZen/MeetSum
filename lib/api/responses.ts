import { NextResponse } from "next/server"

import { WorkspaceStoreError } from "@/lib/workspaces/store"

export function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status })
}

/** Maps a WorkspaceStoreError to its HTTP response; rethrows anything else. */
export function workspaceErrorResponse(error: unknown): Response {
  if (error instanceof WorkspaceStoreError) {
    return NextResponse.json(
      { error: error.code, message: error.message },
      { status: error.status }
    )
  }

  throw error
}
