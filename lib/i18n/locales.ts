/**
 * UI locales (M9, docs/parity/m9.md "Locales"): Hebrew and English only.
 * pt/es/it were removed (user decision, 2026-10-13); their URL prefixes are
 * redirected by the proxy and stored values are coerced to the default.
 * The meeting/content language (`ContentLanguage`) is a separate concept.
 */
export const SUPPORTED_LOCALES = ["he", "en"] as const

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

/** Former UI locales: `/pt/…` etc. get a 308 to the resolved locale. */
export const LEGACY_LOCALES = ["pt", "es", "it"] as const

export type LegacyLocale = (typeof LEGACY_LOCALES)[number]

export const LOCALE_COOKIE = "meetsum_locale"

export function isSupportedLocale(value: string): value is SupportedLocale {
  return SUPPORTED_LOCALES.includes(value as SupportedLocale)
}

export function isLegacyLocale(value: string): value is LegacyLocale {
  return LEGACY_LOCALES.includes(value as LegacyLocale)
}

/**
 * `MEETSUM_DEFAULT_LOCALE` (`he` or `en`), else `he`. Server-only env: in a
 * client bundle the variable is absent and the default is `he`.
 */
export function defaultLocaleFromEnv(
  value: string | undefined = typeof process === "undefined" ? undefined : process.env.MEETSUM_DEFAULT_LOCALE
): SupportedLocale {
  const normalized = value?.trim().toLowerCase() ?? ""

  return isSupportedLocale(normalized) ? normalized : "he"
}

export const DEFAULT_LOCALE: SupportedLocale = defaultLocaleFromEnv()

export function getLocaleDirection(locale: SupportedLocale): "ltr" | "rtl" {
  return locale === "he" ? "rtl" : "ltr"
}

/** Maps one language tag to a UI locale: `he`, `he-*`, `iw` → he; `en`, `en-*` → en. */
export function localeFromLanguageTag(tag: string): SupportedLocale | undefined {
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0] ?? ""

  if (primary === "he" || primary === "iw") return "he"
  if (primary === "en") return "en"
  return undefined
}

/**
 * Parses an Accept-Language header into UI locales, highest q first.
 * `*`, malformed entries and q=0 are ignored; duplicates keep the first.
 */
export function parseAcceptLanguage(header: string | null | undefined): SupportedLocale[] {
  if (!header) return []

  const entries: Array<{ locale: SupportedLocale; q: number; index: number }> = []

  header.split(",").forEach((part, index) => {
    const [rawTag, ...params] = part.trim().split(";")
    const tag = rawTag?.trim() ?? ""

    if (!tag || tag === "*" || !/^[A-Za-z]{1,8}(?:[-_][A-Za-z0-9]{1,8})*$/.test(tag)) return

    let q = 1
    for (const param of params) {
      const match = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(param)
      if (!match) return
      q = Number(match[1])
      if (!Number.isFinite(q) || q < 0 || q > 1) return
    }

    if (q === 0) return

    const locale = localeFromLanguageTag(tag)
    if (locale) entries.push({ locale, q, index })
  })

  entries.sort((a, b) => b.q - a.q || a.index - b.index)

  return [...new Set(entries.map((entry) => entry.locale))]
}

export type LocalePreferenceInput = {
  /** Request pathname; a supported first segment wins. */
  path?: string
  /** `meetsum_locale` cookie value (legacy values are ignored). */
  cookie?: string | null
  /** `users.locale` for a signed-in user. */
  userLocale?: string | null
  acceptLanguage?: string | null
}

/**
 * URL prefix → cookie → users.locale → Accept-Language → default.
 * Every input is allowlisted; anything else falls through.
 */
export function resolveLocalePreference(input: LocalePreferenceInput = {}): SupportedLocale {
  const fromPath = input.path ? getPathLocale(input.path) : undefined
  if (fromPath) return fromPath

  if (input.cookie && isSupportedLocale(input.cookie)) return input.cookie
  if (input.userLocale && isSupportedLocale(input.userLocale)) return input.userLocale

  return parseAcceptLanguage(input.acceptLanguage)[0] ?? DEFAULT_LOCALE
}

/** Coerces a stored or requested locale (including legacy pt/es/it) to a supported one. */
export function coerceLocale(value: unknown, fallback: SupportedLocale = DEFAULT_LOCALE): SupportedLocale {
  return typeof value === "string" && isSupportedLocale(value) ? value : fallback
}

export function getPathLocale(pathname: string): SupportedLocale | undefined {
  const locale = pathname.split("/").filter(Boolean)[0]

  return locale && isSupportedLocale(locale) ? locale : undefined
}

/** The legacy locale prefix of a path (`/pt/tasks` → `pt`), if any. */
export function getLegacyPathLocale(pathname: string): LegacyLocale | undefined {
  const locale = pathname.split("/").filter(Boolean)[0]

  return locale && isLegacyLocale(locale) ? locale : undefined
}

export function replacePathLocale(
  pathname: string,
  locale: SupportedLocale
): string {
  const parts = pathname.split("/")
  const first = parts[1] ?? ""

  if (isSupportedLocale(first) || isLegacyLocale(first)) {
    parts[1] = locale
    return parts.join("/") || `/${locale}`
  }

  return `/${locale}${pathname === "/" ? "" : pathname}`
}
