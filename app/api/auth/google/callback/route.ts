import { NextResponse } from "next/server"

import { exchangeGoogleCodeForIdentity, getGoogleOAuthConfig } from "@/lib/auth/google"
import {
  OAUTH_STATE_COOKIE,
  createSessionCookie,
  getSessionSecret,
  parseAllowedEmails,
} from "@/lib/auth/session"
import { saveGoogleWorkspaceOAuthConnection } from "@/lib/google/oauth-tokens"

function safeReturnTo(value: string | undefined): string {
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/en"
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url)
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? requestUrl.origin
  const loginUrl = new URL("/en/login", appUrl)
  const state = requestUrl.searchParams.get("state")
  const code = requestUrl.searchParams.get("code")
  const stored = request.headers
    .get("cookie")
    ?.split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${OAUTH_STATE_COOKIE}=`))
    ?.slice(OAUTH_STATE_COOKIE.length + 1)
  const [storedState, storedReturnTo] = decodeURIComponent(stored ?? "").split(":")

  if (!code || !state || state !== storedState) {
    loginUrl.searchParams.set("error", "oauth_state")
    return NextResponse.redirect(loginUrl)
  }

  try {
    const identity = await exchangeGoogleCodeForIdentity(
      code,
      getGoogleOAuthConfig()
    )
    const session = createSessionCookie(identity, {
      secret: getSessionSecret(),
      allowedEmails: parseAllowedEmails(process.env.MEETSUM_ALLOWED_EMAILS),
    })

    await saveGoogleWorkspaceOAuthConnection({
      subject: identity.email,
      googleUserId: identity.googleUserId,
      refreshToken: identity.refreshToken,
      scope: identity.scope,
    })

    const response = NextResponse.redirect(
      new URL(safeReturnTo(storedReturnTo), appUrl)
    )

    response.cookies.set(session.name, session.value, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: session.maxAge,
    })
    response.cookies.delete(OAUTH_STATE_COOKIE)

    return response
  } catch {
    loginUrl.searchParams.set("error", "unauthorized")
    return NextResponse.redirect(loginUrl)
  }
}
