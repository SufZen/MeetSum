import { NextResponse } from "next/server"

import { withPublicRoute } from "@/lib/auth/authz"
import { SESSION_COOKIE } from "@/lib/auth/session"
import { DEFAULT_LOCALE, isSupportedLocale } from "@/lib/i18n/locales"
import { ACTIVE_WORKSPACE_COOKIE } from "@/lib/workspaces/constants"

function logoutResponse(request: Request, status: 303 | 307) {
  const requested = new URL(request.url).searchParams.get("locale") ?? ""
  const locale = isSupportedLocale(requested) ? requested : DEFAULT_LOCALE
  // A relative Location keeps the user on whatever origin they reached us on
  // (reverse proxy, custom domain) without depending on NEXT_PUBLIC_APP_URL.
  const response = new NextResponse(null, {
    status,
    headers: { Location: `/${locale}/login` },
  })

  response.cookies.delete(SESSION_COOKIE)
  response.cookies.delete(ACTIVE_WORKSPACE_COOKIE)
  return response
}

// 303 so the browser follows a POST logout with a GET to the login page.
export const POST = withPublicRoute("Clearing a session needs no credentials", (request) =>
  logoutResponse(request, 303)
)

export const GET = withPublicRoute("Clearing a session needs no credentials", (request) =>
  logoutResponse(request, 307)
)
