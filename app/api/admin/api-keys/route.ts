import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import {
  createApiKey,
  listApiKeys,
  normalizeApiKeyScopes,
  type ApiKeyScopeName,
} from "@/lib/auth/api-keys"
import { withAuthz } from "@/lib/auth/authz"
import { recordAuditLog } from "@/lib/audit"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"
import { roleRank } from "@/lib/workspaces/constants"
import { getLogger } from "@/lib/log"

const log = getLogger({ component: "admin/api-keys" })

/**
 * GET /api/admin/api-keys — API keys of the active workspace (masked).
 */
export const GET = withAuthz("api_keys:manage", async (request, ctx) => {
  const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.admin)

  if (rateLimit.blocked) return rateLimit.blocked

  try {
    const keys = await listApiKeys(ctx.workspace.id)

    return NextResponse.json({ keys }, { headers: rateLimit.headers })
  } catch (error) {
    log.error({ err: error }, "[api-keys] list failed")
    return jsonError("Failed to list API keys", 500)
  }
})

/**
 * POST /api/admin/api-keys — Create an API key for the active workspace.
 * Body: { label?: string, expiresAt?: string, scopes?: ("read"|"write"|"admin")[] }
 * Returns the raw key ONCE. It cannot be retrieved again.
 */
export const POST = withAuthz("api_keys:manage", async (request, ctx) => {
  const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.admin)

  if (rateLimit.blocked) return rateLimit.blocked

  const body = (await request.json().catch(() => ({}))) as {
    label?: unknown
    expiresAt?: unknown
    scopes?: unknown
  }
  const label = typeof body.label === "string" ? body.label.trim().slice(0, 120) : ""
  const expiresAt =
    typeof body.expiresAt === "string" && body.expiresAt.trim()
      ? body.expiresAt.trim()
      : null

  if (expiresAt && Number.isNaN(Date.parse(expiresAt))) {
    return jsonError("expiresAt must be an ISO date", 400)
  }

  const requested = body.scopes === undefined ? ["read"] : body.scopes

  if (!Array.isArray(requested)) {
    return jsonError("scopes must be an array", 400)
  }

  const scopes: ApiKeyScopeName[] = normalizeApiKeyScopes(requested)

  if (scopes.length === 0) {
    return jsonError('scopes must include "read", "write" or "admin"', 400)
  }

  // An admin-scope key acts as a workspace admin: only admins/owners mint it.
  if (scopes.includes("admin") && roleRank(ctx.role) < roleRank("admin")) {
    return NextResponse.json(
      { error: "Forbidden", permission: "api_keys:manage" },
      { status: 403 }
    )
  }

  try {
    const { rawKey, record } = await createApiKey({
      workspaceId: ctx.workspace.id,
      label,
      scopes,
      expiresAt,
      createdByUserId: ctx.user?.id ?? ctx.apiKey?.createdByUserId ?? null,
    })

    await recordAuditLog({
      action: "api_key.created",
      ...ctx.audit,
      targetType: "api_key",
      targetId: record.id,
      metadata: { label, keyPrefix: record.keyPrefix, scopes },
    })

    return NextResponse.json(
      { key: rawKey, record },
      { status: 201, headers: rateLimit.headers }
    )
  } catch (error) {
    log.error({ err: error }, "[api-keys] create failed")
    return jsonError("Failed to create API key", 500)
  }
})
