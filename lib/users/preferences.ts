/**
 * Per-user preferences (M9, docs/parity/m9.md A1). Backed by `users.locale`,
 * `users.time_zone` and `users.preferences` (migration 030) on Postgres, and
 * by an in-process map otherwise (dev and tests). Values are normalized on
 * read and write: the locale is allowlisted (`he`/`en`), the zone validated
 * with `Intl.supportedValuesOf("timeZone")`, notification mutes filtered to
 * known kinds. Reads never throw (a failure returns the defaults).
 */
import { getDatabasePool } from "@/lib/db/client"
import { isSupportedLocale, type SupportedLocale } from "@/lib/i18n/locales"
import { isValidTimeZone } from "@/lib/i18n/time-zone"
import {
  DEFAULT_NOTIFICATION_PREFS,
  isNotificationKind,
  type NotificationKind,
  type NotificationPrefs,
} from "@/lib/notifications/types"

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

function defaults(): UserPreferences {
  return { ...DEFAULT_USER_PREFERENCES, notifications: { muted: [...DEFAULT_NOTIFICATION_PREFS.muted] } }
}

export function normalizeLocalePreference(value: unknown): SupportedLocale | null {
  return typeof value === "string" && isSupportedLocale(value) ? value : null
}

export function normalizeTimeZonePreference(value: unknown): string | null {
  return isValidTimeZone(value) ? value : null
}

export function normalizeNotificationPrefs(value: unknown): NotificationPrefs {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  const muted = Array.isArray(raw.muted) ? raw.muted.filter(isNotificationKind) : []

  return { muted: [...new Set<NotificationKind>(muted)] }
}

const memoryPreferences = new Map<string, UserPreferences>()

function usesPostgres(): boolean {
  return process.env.MEETSUM_STORAGE === "postgres"
}

type PreferencesRow = { locale: unknown; time_zone: unknown; preferences: unknown }

function fromRow(row: PreferencesRow | undefined): UserPreferences {
  if (!row) return defaults()

  const stored = row.preferences && typeof row.preferences === "object" ? (row.preferences as Record<string, unknown>) : {}

  return {
    locale: normalizeLocalePreference(row.locale),
    timeZone: normalizeTimeZonePreference(row.time_zone),
    notifications: normalizeNotificationPrefs(stored.notifications),
  }
}

export async function getUserPreferences(userId: string): Promise<UserPreferences> {
  if (!userId) return defaults()

  if (!usesPostgres()) {
    const stored = memoryPreferences.get(userId)

    return stored ? { ...stored, notifications: { muted: [...stored.notifications.muted] } } : defaults()
  }

  try {
    const result = await getDatabasePool().query(
      "select locale, time_zone, preferences from users where id = $1",
      [userId]
    )

    return fromRow(result.rows[0] as PreferencesRow | undefined)
  } catch {
    return defaults()
  }
}

/**
 * Applies a patch (`undefined` keeps a field; `null` clears locale or zone).
 * Invalid values are rejected by the caller (the route validates first) and
 * normalized here as a second line of defence.
 */
export async function updateUserPreferences(
  userId: string,
  patch: UserPreferencesPatch
): Promise<UserPreferences> {
  const current = await getUserPreferences(userId)
  const next: UserPreferences = {
    locale: patch.locale === undefined ? current.locale : normalizeLocalePreference(patch.locale),
    timeZone: patch.timeZone === undefined ? current.timeZone : normalizeTimeZonePreference(patch.timeZone),
    notifications:
      patch.notifications === undefined ? current.notifications : normalizeNotificationPrefs(patch.notifications),
  }

  if (!usesPostgres()) {
    memoryPreferences.set(userId, next)
    return { ...next, notifications: { muted: [...next.notifications.muted] } }
  }

  await getDatabasePool().query(
    `
      update users
         set locale = $2,
             time_zone = $3,
             preferences = coalesce(preferences, '{}'::jsonb) || jsonb_build_object('notifications', $4::jsonb)
       where id = $1
    `,
    [userId, next.locale, next.timeZone, JSON.stringify(next.notifications)]
  )

  return next
}

/** Validates a PATCH body; unknown fields are ignored, invalid ones name the field. */
export type ParsedPreferencesPatch = { ok: true; patch: UserPreferencesPatch } | { ok: false; field: string }

export function parsePreferencesPatch(body: unknown): ParsedPreferencesPatch {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, field: "body" }

  const raw = body as Record<string, unknown>
  const patch: UserPreferencesPatch = {}

  if ("locale" in raw) {
    if (raw.locale !== null && !(typeof raw.locale === "string" && isSupportedLocale(raw.locale))) {
      return { ok: false, field: "locale" }
    }
    patch.locale = raw.locale
  }

  if ("timeZone" in raw) {
    if (raw.timeZone !== null && !isValidTimeZone(raw.timeZone)) return { ok: false, field: "timeZone" }
    patch.timeZone = raw.timeZone
  }

  if ("notifications" in raw) {
    const notifications = raw.notifications as Record<string, unknown> | null

    if (
      !notifications ||
      typeof notifications !== "object" ||
      !Array.isArray(notifications.muted) ||
      !notifications.muted.every(isNotificationKind)
    ) {
      return { ok: false, field: "notifications" }
    }
    patch.notifications = { muted: [...new Set(notifications.muted)] }
  }

  return { ok: true, patch }
}

/** Test helper: forget in-memory preferences. */
export function resetMemoryUserPreferences(): void {
  memoryPreferences.clear()
}
