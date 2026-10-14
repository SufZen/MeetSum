import { withAuthz } from "@/lib/auth/authz"
import { apiError, limitFor } from "@/lib/integrations/core/api"
import { startOAuth } from "@/lib/integrations/core/oauth"
import { oauthStateCookie } from "@/lib/integrations/core/oauth-state"

/**
 * GET /api/integrations/[provider]/oauth/start?returnTo= (M8 A1). Signed,
 * single-use state bound to the user, workspace and provider; nonce cookie;
 * PKCE where the provider supports it. Workspace providers additionally
 * need `integrations:manage` (checked in `startOAuth`). The redirect URI
 * comes from env only, never from request headers.
 */
export const GET = withAuthz<{ provider: string }>("integrations:connect", async (request, ctx, route) => {
  if (ctx.principal !== "user" || !ctx.user) return apiError("user_session_required", 403)

  const limited = await limitFor(request, ctx, "integrationsOAuth")

  if (limited) return limited

  const { provider } = await route.params
  const url = new URL(request.url)
  const result = await startOAuth({
    provider,
    workspaceId: ctx.workspace.id,
    userId: ctx.user.id,
    role: ctx.role,
    returnTo: url.searchParams.get("returnTo"),
    locale: url.searchParams.get("locale") ?? undefined,
  })

  if (!result.ok) return apiError(result.code, result.status)

  return new Response(null, {
    status: 302,
    headers: { location: result.location, "set-cookie": oauthStateCookie(result.nonce), "cache-control": "no-store" },
  })
})
