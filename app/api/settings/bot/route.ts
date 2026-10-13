import { withAuthz } from "@/lib/auth/authz"
import { getBotSettingsResponse, updateBotSettingsResponse } from "@/lib/bot/service"

export const runtime = "nodejs"

/** GET /api/settings/bot — bot auto-join rules (`{enabled:false}` when off). */
export const GET = withAuthz("workspace:read", (_request, ctx) => getBotSettingsResponse(ctx))

/** PUT /api/settings/bot — update rules; auto-join needs the consent acknowledgment. */
export const PUT = withAuthz("settings:write", (request, ctx) =>
  updateBotSettingsResponse(request, ctx)
)
