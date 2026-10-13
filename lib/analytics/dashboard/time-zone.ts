/**
 * The requester's zone for analytics buckets: the per-request i18n zone
 * (users.time_zone → workspace → MEETSUM_DEFAULT_TIMEZONE → Asia/Jerusalem),
 * or the env fallback outside a request (tests, scripts). Server-only.
 */
import { resolveTimeZone } from "@/lib/i18n/time-zone"

export async function resolveRequesterTimeZone(): Promise<string> {
  try {
    const { getRequestI18n } = await import("@/lib/i18n/server")

    return (await getRequestI18n()).timeZone
  } catch {
    return resolveTimeZone({ env: process.env.MEETSUM_DEFAULT_TIMEZONE })
  }
}
