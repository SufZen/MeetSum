import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { withPublicRoute, withSession } from "@/lib/auth/authz"
import { localeCookieOptions } from "@/lib/i18n/cookie"
import { LOCALE_COOKIE, isSupportedLocale, type SupportedLocale } from "@/lib/i18n/locales"
import { updateUserPreferences } from "@/lib/users/preferences"

/**
 * Persists `users.locale` when the request carries a valid session (same
 * session and Origin checks as every session route); anonymous callers
 * (the login page) only get the cookie.
 */
function persistForSession(locale: SupportedLocale) {
  return withSession(async (_request, session) => {
    await updateUserPreferences(session.user.id, { locale })

    return new Response(null, { status: 204 })
  })
}

export const POST = withPublicRoute(
  "UI language preference cookie (also used on the login page); persists users.locale only with a session",
  async (request, route) => {
    const body = (await request.json().catch(() => ({}))) as { locale?: unknown }
    const locale = typeof body.locale === "string" ? body.locale : undefined

    if (!locale || !isSupportedLocale(locale)) {
      return jsonError("Unsupported locale", 400)
    }

    let persisted = false

    try {
      const result = await persistForSession(locale)(request, route)

      persisted = result.status === 204
    } catch {
      persisted = false
    }

    const response = NextResponse.json({ locale, persisted })
    response.cookies.set(LOCALE_COOKIE, locale, localeCookieOptions())

    return response
  }
)
