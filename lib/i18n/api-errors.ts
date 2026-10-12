import type { Dictionary } from "@/lib/i18n/dictionaries"

/**
 * User-facing message for a failed API response body. Known error codes are
 * localized (e.g. C's Google 409 `{ error: "google_not_configured", message }`);
 * otherwise the server `message`, then `error`, then `fallback`.
 */
export function apiErrorMessage(
  body: unknown,
  dictionary: Pick<Dictionary, "googleNotConfigured">,
  fallback: string
): string {
  const record =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {}

  if (record.error === "google_not_configured") {
    return dictionary.googleNotConfigured
  }

  for (const value of [record.message, record.error]) {
    if (typeof value === "string" && value.trim()) return value
  }

  return fallback
}
