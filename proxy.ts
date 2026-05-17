import { NextResponse, type NextRequest } from "next/server"

import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  getPathLocale,
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

  const locale =
    pathname === "/"
      ? resolveLocalePreference(
          request.cookies.get(LOCALE_COOKIE)?.value,
          request.headers.get("accept-language") ?? undefined
        )
      : DEFAULT_LOCALE
  const url = request.nextUrl.clone()

  url.pathname = `/${locale}${pathname === "/" ? "" : pathname}`

  return NextResponse.redirect(url)
}

export const config = {
  matcher: ["/((?!_next|api|.*\\..*).*)"],
}
