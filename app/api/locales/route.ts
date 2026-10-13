import { NextResponse } from "next/server"

import { withPublicRoute } from "@/lib/auth/authz"
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  SUPPORTED_LOCALES,
  getLocaleDirection,
} from "@/lib/i18n/locales"

export const GET = withPublicRoute(
  "Static list of supported UI locales, needed before sign-in.",
  async () =>
    NextResponse.json({
      defaultLocale: DEFAULT_LOCALE,
      cookieName: LOCALE_COOKIE,
      locales: SUPPORTED_LOCALES.map((locale) => ({
        code: locale,
        direction: getLocaleDirection(locale),
      })),
    })
)
