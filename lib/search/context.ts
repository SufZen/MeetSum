/**
 * Search context from an auth context (docs/parity/m6.md, Step 0; owner:
 * Package B). Real: the repository scope drives `meetingScopeSql`, and the
 * principal key keys the per-principal query-embedding cache.
 */
import { NextResponse } from "next/server"

import { toRepoScope, type AuthContext } from "@/lib/auth/authz"
import type { SearchContext } from "@/lib/search/types"

export function searchContextFrom(ctx: AuthContext): SearchContext {
  return {
    scope: toRepoScope(ctx),
    workspaceId: ctx.workspace.id,
    principalKey: ctx.user?.id ?? "key:" + ctx.apiKey?.id,
    meetings: ctx.meetings,
  }
}

/**
 * Rate-limit bucket for every search route: `search:<workspaceId>:<principal>`
 * where principal = user id, else the API key creator's id (an ownerless key
 * falls back to its own id). Null when no identity can be derived; callers
 * must then fail closed (`searchRateLimitUnavailable`).
 */
export function searchRateLimitKey(
  ctx: Pick<AuthContext, "principal" | "user" | "apiKey" | "workspace">
): string | null {
  const principal =
    ctx.principal === "user"
      ? ctx.user?.id
      : (ctx.apiKey?.createdByUserId ?? (ctx.apiKey?.id ? `key:${ctx.apiKey.id}` : undefined))
  const workspaceId = ctx.workspace?.id

  if (!workspaceId || !principal) return null

  return `search:${workspaceId}:${principal}`
}

/** Fail-closed answer when no rate-limit identity exists. */
export function searchRateLimitUnavailable(): Response {
  return NextResponse.json({ error: "Too many requests" }, { status: 429 })
}
