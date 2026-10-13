/**
 * Time-zone resolution (M9, docs/parity/m9.md "Time zone and formatting"):
 * users.time_zone → workspace_settings.timeZone → MEETSUM_DEFAULT_TIMEZONE →
 * Asia/Jerusalem, each validated. Package A makes `getTaskTimeZone()` (M5) a
 * thin wrapper over this resolver and adds the workspace setting.
 */

export const FALLBACK_TIME_ZONE = "Asia/Jerusalem"

let supportedZones: Set<string> | undefined

/** Validates an IANA zone against `Intl.supportedValuesOf("timeZone")` (plus UTC). */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false

  if (!supportedZones) {
    const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] }

    supportedZones = new Set(intl.supportedValuesOf?.("timeZone") ?? [])
    supportedZones.add("UTC")
  }

  return supportedZones.has(value)
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
