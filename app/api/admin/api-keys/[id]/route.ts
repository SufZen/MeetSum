import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { revokeApiKey } from "@/lib/auth/api-keys"
import { withAuthz } from "@/lib/auth/authz"
import { recordAuditLog } from "@/lib/audit"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"

/**
 * DELETE /api/admin/api-keys/:id — Revoke an API key of the active workspace.
 */
export const DELETE = withAuthz<{ id: string }>(
  "api_keys:manage",
  async (request, ctx, { params }) => {
    const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.admin)

    if (rateLimit.blocked) return rateLimit.blocked

    const { id } = await params

    try {
      const revoked = await revokeApiKey(ctx.workspace.id, id)

      if (!revoked) {
        return jsonError("API key not found or already revoked", 404)
      }

      await recordAuditLog({
        action: "api_key.revoked",
        ...ctx.audit,
        targetType: "api_key",
        targetId: id,
        metadata: { label: revoked.label, keyPrefix: revoked.keyPrefix },
      })

      return NextResponse.json({ revoked }, { headers: rateLimit.headers })
    } catch (error) {
      console.error("[api-keys] revoke failed", error)
      return jsonError("Failed to revoke API key", 500)
    }
  }
)
