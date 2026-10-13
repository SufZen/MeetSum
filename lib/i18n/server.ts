/**
 * Per-request i18n (M9 Step 0, docs/parity/m9.md item 3; owner: Package A).
 * Resolves locale, direction, time zone and dictionary once per request for
 * server components and route handlers; `I18nProvider` receives the result.
 * Server-only.
 */
import { cache } from "react"

import { getDictionary, type Dictionary } from "@/lib/i18n/dictionaries"
import {
  LOCALE_COOKIE,
  getLocaleDirection,
  isSupportedLocale,
  resolveLocalePreference,
  type SupportedLocale,
} from "@/lib/i18n/locales"
import { resolveTimeZone } from "@/lib/i18n/time-zone"
import { getUserPreferences, type UserPreferences } from "@/lib/users/preferences"

export type RequestI18n = {
  locale: SupportedLocale
  dir: "rtl" | "ltr"
  timeZone: string
  dictionary: Dictionary
}

const loadSessionPreferences = cache(async (): Promise<UserPreferences | null> => {
  try {
    const { getServerAuthState } = await import("@/lib/auth/authz")
    const auth = await getServerAuthState()

    if (auth.status === "unauthenticated") return null

    return await getUserPreferences(auth.session.user.id)
  } catch {
    return null
  }
})

/**
 * URL locale (when the caller knows it) → cookie → users.locale →
 * Accept-Language → default. Zone: users.time_zone → workspace (Package A)
 * → MEETSUM_DEFAULT_TIMEZONE → Asia/Jerusalem. Never throws.
 */
export async function getRequestI18n(options: { locale?: string } = {}): Promise<RequestI18n> {
  const { cookies, headers } = await import("next/headers")
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()])
  const preferences = await loadSessionPreferences()
  const locale =
    options.locale && isSupportedLocale(options.locale)
      ? options.locale
      : resolveLocalePreference({
          cookie: cookieStore.get(LOCALE_COOKIE)?.value,
          userLocale: preferences?.locale,
          acceptLanguage: headerStore.get("accept-language"),
        })

  return {
    locale,
    dir: getLocaleDirection(locale),
    timeZone: resolveTimeZone({
      user: preferences?.timeZone,
      env: process.env.MEETSUM_DEFAULT_TIMEZONE,
    }),
    dictionary: getDictionary(locale),
  }
}
