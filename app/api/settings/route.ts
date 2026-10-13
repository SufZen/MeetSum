import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { withAuthz } from "@/lib/auth/authz"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"
import { getAppSettings, updateAppSettings } from "@/lib/settings/app-settings"

export const GET = withAuthz("workspace:read", async (_request, ctx) =>
  NextResponse.json({ settings: await getAppSettings(ctx.workspace.id) })
)

export const PATCH = withAuthz("settings:write", async (request, ctx) => {
  const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.admin)

  if (rateLimit.blocked) return rateLimit.blocked

  let patch: Record<string, unknown>

  try {
    const body = (await request.json()) as unknown

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return jsonError("Settings patch must be an object", 400)
    }

    patch = body as Record<string, unknown>
  } catch {
    return jsonError("Invalid JSON body", 400)
  }

  try {
    const settings = await updateAppSettings(ctx.workspace.id, patch)

    await recordAuditLog({
      action: "admin.settings.updated",
      ...ctx.audit,
      targetType: "workspace",
      targetId: ctx.workspace.id,
      metadata: { keys: Object.keys(patch) },
    })

    // The workspace default never overrides a user's locale choice: the
    // `meetsum_locale` cookie belongs to the user (language switcher,
    // `users.locale`), so a settings PATCH leaves it alone (M9 Integration).
    return NextResponse.json({ settings }, { headers: rateLimit.headers })
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Unable to update settings",
      400
    )
  }
})
