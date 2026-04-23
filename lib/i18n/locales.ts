export const SUPPORTED_LOCALES = ["en", "he", "pt", "es", "it"] as const

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

export const DEFAULT_LOCALE: SupportedLocale = "en"
export const LOCALE_COOKIE = "meetsum_locale"

export function isSupportedLocale(value: string): value is SupportedLocale {
  return SUPPORTED_LOCALES.includes(value as SupportedLocale)
}

export function getLocaleDirection(locale: SupportedLocale): "ltr" | "rtl" {
  return locale === "he" ? "rtl" : "ltr"
}

export function resolveLocalePreference(
  savedLocale?: string,
  acceptLanguage?: string
): SupportedLocale {
  void acceptLanguage

  return savedLocale && isSupportedLocale(savedLocale)
    ? savedLocale
    : DEFAULT_LOCALE
}

export function getPathLocale(pathname: string): SupportedLocale | undefined {
  const locale = pathname.split("/").filter(Boolean)[0]

  return locale && isSupportedLocale(locale) ? locale : undefined
}

export function replacePathLocale(
  pathname: string,
  locale: SupportedLocale
): string {
  const parts = pathname.split("/")

  if (isSupportedLocale(parts[1] ?? "")) {
    parts[1] = locale
    return parts.join("/") || `/${locale}`
  }

  return `/${locale}${pathname === "/" ? "" : pathname}`
}
