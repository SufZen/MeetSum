import { DEFAULT_LOCALE, isSupportedLocale } from "@/lib/i18n/locales"

/** Same-origin relative path, or the default home. Blocks `//host` and `/\host`. */
export function safeReturnTo(value: string | null | undefined): string {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\u0000-\u001f]/.test(value)
  ) {
    return `/${DEFAULT_LOCALE}`
  }

  return value
}

const INVITE_RETURN_TO = /^\/([a-z]{2})\/invite\/(inv_[A-Za-z0-9_-]{43})$/

/** `/{locale}/invite/{token}` return paths (M2 spec A4). */
export function parseInviteReturnTo(
  value: string
): { locale: string; token: string } | undefined {
  const match = INVITE_RETURN_TO.exec(value)

  return match ? { locale: match[1], token: match[2] } : undefined
}

/** Locale prefix of a return path, else the default locale. */
export function localeOfPath(value: string): string {
  const candidate = value.split("/")[1] ?? ""

  return isSupportedLocale(candidate) ? candidate : DEFAULT_LOCALE
}
