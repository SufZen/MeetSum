import { NextResponse } from "next/server"

import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  SUPPORTED_LOCALES,
  getLocaleDirection,
} from "@/lib/i18n/locales"

export async function GET() {
  return NextResponse.json({
    defaultLocale: DEFAULT_LOCALE,
    cookieName: LOCALE_COOKIE,
    locales: SUPPORTED_LOCALES.map((locale) => ({
      code: locale,
      direction: getLocaleDirection(locale),
    })),
  })
}
