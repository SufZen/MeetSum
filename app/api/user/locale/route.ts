import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { withPublicRoute } from "@/lib/auth/authz"
import {
  LOCALE_COOKIE,
  isSupportedLocale,
  type SupportedLocale,
} from "@/lib/i18n/locales"

export const POST = withPublicRoute(
  "UI language preference cookie (also used on the login page)",
  async (request) => {
    const body = (await request.json().catch(() => ({}))) as { locale?: unknown }
    const locale = typeof body.locale === "string" ? body.locale : undefined

    if (!locale || !isSupportedLocale(locale)) {
      return jsonError("Unsupported locale", 400)
    }

    const response = NextResponse.json({ locale: locale as SupportedLocale })
    response.cookies.set(LOCALE_COOKIE, locale, {
      httpOnly: false,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    })

    return response
  }
)
