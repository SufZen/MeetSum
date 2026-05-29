import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { revokeApiKey } from "@/lib/auth/api-keys"
import { recordAuditLog } from "@/lib/audit"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"

/**
 * DELETE /api/admin/api-keys/:id — Revoke an API key.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.admin)

  if (rateLimit.blocked) return rateLimit.blocked

  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const { id } = await params

  try {
    const revoked = await revokeApiKey(id)

    if (!revoked) {
      return jsonError("API key not found or already revoked", 404)
    }

    await recordAuditLog({
      action: "api_key.revoked",
      targetType: "api_key",
      targetId: id,
      metadata: { label: revoked.label, keyPrefix: revoked.keyPrefix },
    })

    return NextResponse.json({ revoked }, { headers: rateLimit.headers })
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Failed to revoke API key",
      500
    )
  }
}
