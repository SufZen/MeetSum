/**
 * Per-user preferences (M9 Step 0 contract, docs/parity/m9.md item 6; owner:
 * Package A). Backed by `users.locale`, `users.time_zone` and
 * `users.preferences` (migration 030). Step 0 ships the types and no-op
 * functions that never throw; Package A implements persistence.
 */
import type { SupportedLocale } from "@/lib/i18n/locales"
import { DEFAULT_NOTIFICATION_PREFS, type NotificationPrefs } from "@/lib/notifications/types"

export type UserPreferences = {
  /** UI locale; null = not chosen (cookie / Accept-Language decide). */
  locale: SupportedLocale | null
  /** IANA zone; null = workspace or server default. */
  timeZone: string | null
  notifications: NotificationPrefs
}

export type UserPreferencesPatch = Partial<UserPreferences>

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  locale: null,
  timeZone: null,
  notifications: DEFAULT_NOTIFICATION_PREFS,
}

export async function getUserPreferences(userId: string): Promise<UserPreferences> {
  void userId

  return { ...DEFAULT_USER_PREFERENCES, notifications: { muted: [...DEFAULT_NOTIFICATION_PREFS.muted] } }
}

export async function updateUserPreferences(
  userId: string,
  patch: UserPreferencesPatch
): Promise<UserPreferences> {
  const current = await getUserPreferences(userId)

  return {
    locale: patch.locale === undefined ? current.locale : patch.locale,
    timeZone: patch.timeZone === undefined ? current.timeZone : patch.timeZone,
    notifications: patch.notifications ?? current.notifications,
  }
}
