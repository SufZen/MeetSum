import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"
import { listAuditLogs, type AuditAction, type AuditLogEntry } from "@/lib/audit"
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
  const result = (await listAuditLogs(query)) as unknown as
    | AuditLogEntry[]
    | { logs: AuditLogEntry[]; nextCursor?: string | null }

  const logs = Array.isArray(result) ? result : result.logs
  const nextCursor = Array.isArray(result)
    ? logs.length === limit
      ? (logs[logs.length - 1]?.createdAt ?? null)
      : null
    : (result.nextCursor ?? null)

  return NextResponse.json({ logs, nextCursor }, { headers: rateLimit.headers })
})
