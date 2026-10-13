import { NextResponse, type NextRequest } from "next/server"

import {
  LOCALE_COOKIE,
  getLegacyPathLocale,
  getPathLocale,
  replacePathLocale,
  resolveLocalePreference,
  type SupportedLocale,
} from "@/lib/i18n/locales"

/**
 * Locale routing (M9 A1, docs/parity/m9.md "Locales"). Every locale-less page
 * path resolves through cookie → Accept-Language → default (`users.locale`
 * reaches the cookie at sign-in and on every switch, so the proxy needs no
 * database). Legacy `/pt|es|it/…` prefixes get a 308 with the rest of the
 * path and the query kept. Redirects carry `Vary: Accept-Language, Cookie`.
 */
const PASS_THROUGH_ROOTS = ["/api", "/_next", "/share", "/icons"]
const PASS_THROUGH_PATHS = new Set(["/sw.js", "/manifest.webmanifest", "/offline.html", "/favicon.ico"])
const PUBLIC_FILE = /\.[^/]+$/
const VARY = "Accept-Language, Cookie"

export type LocaleRouting =
  | { kind: "pass" }
  | { kind: "redirect"; pathname: string; status: 307 | 308 }

function isPassThrough(pathname: string): boolean {
  if (PASS_THROUGH_PATHS.has(pathname)) return true
  if (PASS_THROUGH_ROOTS.some((root) => pathname === root || pathname.startsWith(`${root}/`))) return true

  return PUBLIC_FILE.test(pathname)
}

/** Pure routing decision (tested without a request object). */
export function routeLocale(
  pathname: string,
  input: { cookie?: string | null; acceptLanguage?: string | null }
): LocaleRouting {
  if (isPassThrough(pathname) || getPathLocale(pathname)) return { kind: "pass" }

  const locale: SupportedLocale = resolveLocalePreference({
    cookie: input.cookie,
    acceptLanguage: input.acceptLanguage,
  })

  if (getLegacyPathLocale(pathname)) {
    return { kind: "redirect", pathname: replacePathLocale(pathname, locale), status: 308 }
  }

  return { kind: "redirect", pathname: `/${locale}${pathname === "/" ? "" : pathname}`, status: 307 }
}

export function proxy(request: NextRequest) {
  const decision = routeLocale(request.nextUrl.pathname, {
    cookie: request.cookies.get(LOCALE_COOKIE)?.value,
    acceptLanguage: request.headers.get("accept-language"),
  })

  if (decision.kind === "pass") return NextResponse.next()

  const url = request.nextUrl.clone()

  url.pathname = decision.pathname
  const response = NextResponse.redirect(url, decision.status)

  response.headers.set("Vary", VARY)
  return response
}

export const config = {
  matcher: ["/((?!_next|api|.*\\..*).*)"],
}
