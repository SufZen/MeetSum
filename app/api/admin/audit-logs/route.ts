import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import {
  InvalidAuditCursorError,
  listAuditLogsPage,
  type AuditAction,
} from "@/lib/audit"
import { withAuthz } from "@/lib/auth/authz"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"

function param(url: URL, name: string, max = 200): string | undefined {
  const value = url.searchParams.get(name)?.trim()

  return value ? value.slice(0, max) : undefined
}

/**
 * GET /api/admin/audit-logs — audit trail of the active workspace.
 * Query: action, actor, targetType, targetId, before (cursor), limit (≤ 200).
 * Response: { logs, nextCursor }.
 */
export const GET = withAuthz("audit:read", async (request, ctx) => {
  const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.admin)

  if (rateLimit.blocked) return rateLimit.blocked

  const url = new URL(request.url)
  const parsedLimit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10)
  const limit = Math.min(Math.max(Number.isFinite(parsedLimit) ? parsedLimit : 50, 1), 200)
  // The workspace filter is mandatory and always comes from the auth context.
  const query = {
    workspaceId: ctx.workspace.id,
    action: param(url, "action") as AuditAction | undefined,
    actor: param(url, "actor"),
    targetType: param(url, "targetType"),
    targetId: param(url, "targetId"),
    before: param(url, "before", 500),
    limit,
  }
  try {
    const { logs, nextCursor } = await listAuditLogsPage(query)

    return NextResponse.json(
      { logs, nextCursor: nextCursor ?? null },
      { headers: rateLimit.headers }
    )
  } catch (error) {
    if (error instanceof InvalidAuditCursorError) {
      return jsonError("Invalid cursor", 400)
    }

    throw error
  }
})
