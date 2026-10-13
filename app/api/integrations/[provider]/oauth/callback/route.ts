import { readRequestCookie } from "@/lib/auth/session"
import { withSession } from "@/lib/auth/authz"
import { completeOAuth } from "@/lib/integrations/core/oauth"
import { clearOAuthStateCookie, OAUTH_STATE_COOKIE } from "@/lib/integrations/core/oauth-state"

/**
 * GET /api/integrations/[provider]/oauth/callback (M8 A1). `withSession`:
 * membership and the required permission are re-checked for the state's
 * workspace (never taken from the state). Every failure redirects with a
 * fixed `integration_error` code; provider text is never reflected. The
 * nonce cookie is always cleared.
 */
export const GET = withSession<{ provider: string }>(async (request, session, route) => {
  const { provider } = await route.params
  const result = await completeOAuth({
    provider,
    session,
    query: new URL(request.url).searchParams,
    cookieNonce: readRequestCookie(request, OAUTH_STATE_COOKIE),
  })

  return new Response(null, {
    status: 302,
    headers: { location: result.location, "set-cookie": clearOAuthStateCookie(), "cache-control": "no-store" },
  })
})
