/**
 * Time-zone resolution (M9, docs/parity/m9.md "Time zone and formatting"):
 * users.time_zone → workspace_settings.timeZone → MEETSUM_DEFAULT_TIMEZONE →
 * Asia/Jerusalem, each validated. `getTaskTimeZone()` (M5) wraps this
 * resolver; `getRequestI18n()` feeds it the session user's and workspace's
 * values. Pure and client-safe.
 */

export const FALLBACK_TIME_ZONE = "Asia/Jerusalem"

let supportedZones: Set<string> | undefined

function zoneSet(): Set<string> {
  if (!supportedZones) {
    const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] }

    supportedZones = new Set(intl.supportedValuesOf?.("timeZone") ?? [])
    supportedZones.add("UTC")
  }

  return supportedZones
}

/** Validates an IANA zone against `Intl.supportedValuesOf("timeZone")` (plus UTC). */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false

  return zoneSet().has(value)
}

/** Every supported zone, sorted (for pickers). */
export function listTimeZones(): string[] {
  return [...zoneSet()].sort()
}

export function resolveTimeZone(input: {
  user?: string | null
  workspace?: string | null
  env?: string | null
} = {}): string {
  for (const candidate of [input.user, input.workspace, input.env?.trim()]) {
    if (isValidTimeZone(candidate)) return candidate
  }

  return FALLBACK_TIME_ZONE
}
