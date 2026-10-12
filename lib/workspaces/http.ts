import type { NextResponse } from "next/server"

import { SESSION_MAX_AGE_SECONDS } from "@/lib/auth/session"
import { ACTIVE_WORKSPACE_COOKIE } from "@/lib/workspaces/constants"

/** httpOnly, SameSite=Lax cookie selecting the session user's active workspace. */
export function setActiveWorkspaceCookie(response: NextResponse, workspaceId: string) {
  response.cookies.set(ACTIVE_WORKSPACE_COOKIE, workspaceId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS * 4,
  })
}

/** `MEETSUM_ALLOW_WORKSPACE_CREATION` (default true). */
export function isWorkspaceCreationAllowed(env: NodeJS.ProcessEnv = process.env) {
  return env.MEETSUM_ALLOW_WORKSPACE_CREATION?.trim().toLowerCase() !== "false"
}

/** Parses a JSON object body; undefined for invalid JSON or non-objects. */
export async function readJsonObject(
  request: Request
): Promise<Record<string, unknown> | undefined> {
  try {
    const body = (await request.json()) as unknown

    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}
