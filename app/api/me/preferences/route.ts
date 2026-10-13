/**
 * GET/PATCH /api/me/preferences: UI locale, time zone and notification mutes
 * of the signed-in user (docs/parity/m9.md A1). `withSession` rejects API
 * keys. PATCH validates every field (locale allowlisted, zone checked with
 * `Intl.supportedValuesOf`, mutes limited to known kinds) and refreshes the
 * locale cookie when the locale changes.
 */
import { NextResponse } from "next/server"

import { withSession } from "@/lib/auth/authz"
import { localeCookieOptions } from "@/lib/i18n/cookie"
import { LOCALE_COOKIE } from "@/lib/i18n/locales"
import { getUserPreferences, parsePreferencesPatch, updateUserPreferences } from "@/lib/users/preferences"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = withSession(async (_request, session) =>
  NextResponse.json({ preferences: await getUserPreferences(session.user.id) })
)

export const PATCH = withSession(async (request, session) => {
  const body = (await request.json().catch(() => undefined)) as unknown
  const parsed = parsePreferencesPatch(body)

  if (!parsed.ok) {
    return NextResponse.json(
      { error: "validation_failed", field: parsed.field, message: `Invalid ${parsed.field}` },
      { status: 400 }
    )
  }

  const before = await getUserPreferences(session.user.id)
  const preferences = await updateUserPreferences(session.user.id, parsed.patch)
  const response = NextResponse.json({ preferences })

  if (preferences.locale && preferences.locale !== before.locale) {
    response.cookies.set(LOCALE_COOKIE, preferences.locale, localeCookieOptions())
  }

  return response
})
