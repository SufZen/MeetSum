/**
 * Per-request i18n (M9, docs/parity/m9.md "Time zone and formatting").
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
import type { UserPreferences } from "@/lib/users/preferences"

export type RequestI18n = {
  locale: SupportedLocale
  dir: "rtl" | "ltr"
  timeZone: string
  dictionary: Dictionary
}

type SessionI18nContext = {
  preferences: UserPreferences | null
  workspaceTimeZone: string | null
}

/** The session user's preferences and the active workspace's zone, once per request. */
const loadSessionContext = cache(async (): Promise<SessionI18nContext> => {
  try {
    const { getServerAuthState } = await import("@/lib/auth/authz")
    const auth = await getServerAuthState()

    if (auth.status === "unauthenticated") return { preferences: null, workspaceTimeZone: null }

    const { getUserPreferences } = await import("@/lib/users/preferences")
    const preferences = await getUserPreferences(auth.session.user.id)
    let workspaceTimeZone: string | null = null

    if (auth.status === "ok") {
      try {
        const { getAppSettings } = await import("@/lib/settings/app-settings")

        workspaceTimeZone = (await getAppSettings(auth.ctx.workspace.id)).timeZone
      } catch {
        workspaceTimeZone = null
      }
    }

    return { preferences, workspaceTimeZone }
  } catch {
    return { preferences: null, workspaceTimeZone: null }
  }
})

/**
 * URL locale (when the caller knows it) → cookie → users.locale →
 * Accept-Language → default. Zone: users.time_zone → workspace setting →
 * MEETSUM_DEFAULT_TIMEZONE → Asia/Jerusalem. Never throws.
 */
export async function getRequestI18n(options: { locale?: string } = {}): Promise<RequestI18n> {
  const { cookies, headers } = await import("next/headers")
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()])
  const { preferences, workspaceTimeZone } = await loadSessionContext()
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
      workspace: workspaceTimeZone,
      env: process.env.MEETSUM_DEFAULT_TIMEZONE,
    }),
    dictionary: getDictionary(locale),
  }
}
