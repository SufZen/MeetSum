import { isSupportedLocale, parseAcceptLanguage, type SupportedLocale } from "@/lib/i18n/locales"

/**
 * Chrome language of a public share page (M9 B7): `?lang=` → the
 * `meetsum_locale` cookie → Accept-Language → the meeting's language (he/en)
 * → `he`. Only `he`/`en` are accepted from any source. The page chrome
 * (labels, gate, dates) follows this; content blocks keep the meeting or
 * segment language.
 */
export function resolveShareViewerLocale(input: {
  lang?: string | string[] | null
  cookie?: string | null
  acceptLanguage?: string | null
  meetingLocale?: SupportedLocale | null
}): SupportedLocale {
  const lang = Array.isArray(input.lang) ? input.lang[0] : input.lang

  if (lang && isSupportedLocale(lang)) return lang
  if (input.cookie && isSupportedLocale(input.cookie)) return input.cookie

  const fromHeader = parseAcceptLanguage(input.acceptLanguage)[0]

  if (fromHeader) return fromHeader
  if (input.meetingLocale && isSupportedLocale(input.meetingLocale)) return input.meetingLocale

  return "he"
}

export function shareLocaleDir(locale: SupportedLocale): "rtl" | "ltr" {
  return locale === "he" ? "rtl" : "ltr"
}
