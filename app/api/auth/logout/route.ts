import { NextResponse } from "next/server"

import { SESSION_COOKIE } from "@/lib/auth/session"
import { DEFAULT_LOCALE, isSupportedLocale } from "@/lib/i18n/locales"

function logoutResponse(request: Request, status: 303 | 307) {
  const requested = new URL(request.url).searchParams.get("locale") ?? ""
  const locale = isSupportedLocale(requested) ? requested : DEFAULT_LOCALE
  const response = NextResponse.redirect(
    new URL(
      `/${locale}/login`,
      process.env.NEXT_PUBLIC_APP_URL ?? "http://127.0.0.1:3000"
    ),
    status
  )

  response.cookies.delete(SESSION_COOKIE)
  return response
}

// 303 so the browser follows a POST logout with a GET to the login page.
export async function POST(request: Request) {
  return logoutResponse(request, 303)
}

export async function GET(request: Request) {
  return logoutResponse(request, 307)
}
