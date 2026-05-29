import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { createApiKey, listApiKeys } from "@/lib/auth/api-keys"
import { recordAuditLog } from "@/lib/audit"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"

/**
 * GET /api/admin/api-keys — List all API keys (masked).
 */
export async function GET(request: Request) {
  const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.admin)

  if (rateLimit.blocked) return rateLimit.blocked

  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  try {
    const keys = await listApiKeys()

    return NextResponse.json({ keys }, { headers: rateLimit.headers })
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Failed to list API keys",
      500
    )
  }
}

/**
 * POST /api/admin/api-keys — Create a new API key.
 * Body: { label?: string, expiresAt?: string }
 * Returns the raw key ONCE. It cannot be retrieved again.
 */
export async function POST(request: Request) {
  const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.admin)

  if (rateLimit.blocked) return rateLimit.blocked

  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  try {
    const body = (await request.json().catch(() => ({}))) as {
      label?: unknown
      expiresAt?: unknown
    }

    const label = typeof body.label === "string" ? body.label.trim() : ""
    const expiresAt =
      typeof body.expiresAt === "string" && body.expiresAt.trim()
        ? body.expiresAt.trim()
        : null

    const { rawKey, record } = await createApiKey({ label, expiresAt })

    await recordAuditLog({
      action: "api_key.created",
      targetType: "api_key",
      targetId: record.id,
      metadata: { label, keyPrefix: record.keyPrefix },
    })

    return NextResponse.json(
      { key: rawKey, record },
      { status: 201, headers: rateLimit.headers }
    )
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Failed to create API key",
      500
    )
  }
}
