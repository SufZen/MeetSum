/**
 * M9 Step 0 route stubs: the final guard runs first (withAuthz/withSession,
 * then the user-principal check), then 501 until the owning package lands.
 * Server-only.
 */
import { NextResponse } from "next/server"

import type { AuthContext } from "@/lib/auth/authz"

/** 403 `user_required` for API-key principals (dashboards are for people). */
export function userRequiredResponse(): Response {
  return NextResponse.json({ error: "Forbidden", reason: "user_required" }, { status: 403 })
}

/** True when the request is a signed-in user (not an API key). */
export function isUserPrincipal(ctx: Pick<AuthContext, "principal">): boolean {
  return ctx.principal === "user"
}

export function notImplementedResponse(feature: string): Response {
  return NextResponse.json(
    { error: "Not implemented", reason: "not_implemented", feature },
    { status: 501, headers: { "cache-control": "no-store" } }
  )
}
