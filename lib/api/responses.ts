import { NextResponse } from "next/server"

import { authenticateRequest } from "@/lib/auth/authz"
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

/**
 * @deprecated M2: wrap routes with `withAuthz` / `withSession` /
 * `withPublicRoute` (lib/auth/authz.ts). Removed at Integration.
 *
 * Legacy gate kept so not-yet-migrated routes still compile: it now runs the
 * real M2 authentication (invalid bearer → 401 without cookie fallback,
 * per-request membership, Origin check) but checks no permission.
 */
export async function requireAppAccess(request: Request) {
  const resolved = await authenticateRequest(request)

  return resolved.ok ? undefined : resolved.response
}
