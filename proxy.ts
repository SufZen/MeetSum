import { NextResponse, type NextRequest } from "next/server"

import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  getLegacyPathLocale,
  getPathLocale,
  replacePathLocale,
  resolveLocalePreference,
} from "@/lib/i18n/locales"

const PUBLIC_FILE = /\.[^/]+$/

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (
    pathname.startsWith("/api") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/share") ||
    PUBLIC_FILE.test(pathname)
  ) {
    return NextResponse.next()
  }

  if (getPathLocale(pathname)) {
    return NextResponse.next()
  }

  const preference = () =>
    resolveLocalePreference({
      cookie: request.cookies.get(LOCALE_COOKIE)?.value,
      acceptLanguage: request.headers.get("accept-language"),
    })

  // M9 removed pt/es/it: `/pt/tasks` → 308 `/he/tasks` (path and query kept),
  // so a legacy link never hits the `[locale]` layout's 404. The full
  // resolution chain for every locale-less path is Package A's (A1).
  if (getLegacyPathLocale(pathname)) {
    const url = request.nextUrl.clone()

    url.pathname = replacePathLocale(pathname, preference())
    const response = NextResponse.redirect(url, 308)

    response.headers.set("Vary", "Accept-Language, Cookie")
    return response
  }

  const locale = pathname === "/" ? preference() : DEFAULT_LOCALE
  const url = request.nextUrl.clone()

  url.pathname = `/${locale}${pathname === "/" ? "" : pathname}`

  return NextResponse.redirect(url)
}

export const config = {
  matcher: ["/((?!_next|api|.*\\..*).*)"],
}
