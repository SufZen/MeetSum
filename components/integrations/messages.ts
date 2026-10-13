import { formatMessage, type Dictionary } from "@/lib/i18n/dictionaries"
import type { integrationsMessagesEn } from "@/lib/i18n/m8/integrations"

export type IntegrationsMessageKey = keyof typeof integrationsMessagesEn

/** A localized integrations message with `{placeholders}` filled (plain text). */
export function im(
  t: Dictionary,
  key: IntegrationsMessageKey,
  values?: Record<string, string | number | undefined>
): string {
  return values ? formatMessage(t[key], values) : t[key]
}
