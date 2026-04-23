import { NextResponse } from "next/server"

import { getGoogleOAuthConfig } from "@/lib/auth/google"
import {
  OAUTH_STATE_COOKIE,
  createGoogleAuthorizationUrl,
  createOAuthState,
} from "@/lib/auth/session"

export async function GET(request: Request) {
  const config = getGoogleOAuthConfig()
  const requestUrl = new URL(request.url)
  const returnTo = requestUrl.searchParams.get("returnTo") ?? "/en"
  const state = createOAuthState()
  const response = NextResponse.redirect(
    createGoogleAuthorizationUrl({
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      state,
      loginHint: process.env.GOOGLE_WORKSPACE_ADMIN_EMAIL,
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
}
