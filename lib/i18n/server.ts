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

async function workspaceTimeZoneOf(workspaceId: string | null | undefined): Promise<string | null> {
  if (!workspaceId) return null

  try {
    const { getAppSettings } = await import("@/lib/settings/app-settings")

    return (await getAppSettings(workspaceId)).timeZone
  } catch {
    return null
  }
}

/**
 * The zone chain for a known scope (route handlers that have an authz
 * context, including API keys): users.time_zone → that workspace's setting →
 * MEETSUM_DEFAULT_TIMEZONE → Asia/Jerusalem. Never throws.
 */
export async function resolveScopedTimeZone(scope: {
  userId?: string | null
  workspaceId?: string | null
}): Promise<string> {
  const [user, workspace] = await Promise.all([
    (async () => {
      if (!scope.userId) return null
      try {
        const { getUserPreferences } = await import("@/lib/users/preferences")

        return (await getUserPreferences(scope.userId)).timeZone
      } catch {
        return null
      }
    })(),
    workspaceTimeZoneOf(scope.workspaceId),
  ])

  return resolveTimeZone({ user, workspace, env: process.env.MEETSUM_DEFAULT_TIMEZONE })
}

/**
 * Public share pages: the signed-in viewer's zone when there is a session,
 * else the shared meeting's workspace zone, then MEETSUM_DEFAULT_TIMEZONE →
 * Asia/Jerusalem. Never throws.
 */
export async function getShareTimeZone(meetingWorkspaceId?: string | null): Promise<string> {
  const [{ preferences }, workspace] = await Promise.all([
    loadSessionContext(),
    workspaceTimeZoneOf(meetingWorkspaceId),
  ])

  return resolveTimeZone({ user: preferences?.timeZone, workspace, env: process.env.MEETSUM_DEFAULT_TIMEZONE })
}
