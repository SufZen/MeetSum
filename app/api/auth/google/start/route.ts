import { NextResponse } from "next/server"

import { withPublicRoute } from "@/lib/auth/authz"
import { getGoogleOAuthConfig } from "@/lib/auth/google"
import { safeReturnTo } from "@/lib/auth/return-to"
import {
  OAUTH_STATE_COOKIE,
  createGoogleAuthorizationUrl,
  createOAuthState,
} from "@/lib/auth/session"
import { flattenGoogleWorkspaceScopes } from "@/lib/google/workspace"
import { isValidEmail, normalizeEmail } from "@/lib/workspaces/tokens"

export const GET = withPublicRoute("Starts Google sign-in", async (request) => {
  const config = getGoogleOAuthConfig()
  const requestUrl = new URL(request.url)
  const returnTo = safeReturnTo(requestUrl.searchParams.get("returnTo"))
  const hint = normalizeEmail(requestUrl.searchParams.get("loginHint") ?? "")
  const state = createOAuthState()
  const response = NextResponse.redirect(
    createGoogleAuthorizationUrl({
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      state,
      ...(hint && isValidEmail(hint) ? { loginHint: hint } : {}),
      scopes: [
        "openid",
        "email",
        "profile",
        ...flattenGoogleWorkspaceScopes(),
      ],
      prompt: "consent select_account",
    })
  )

  response.cookies.set(OAUTH_STATE_COOKIE, `${state}:${returnTo}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 10,
  })

  return response
})
