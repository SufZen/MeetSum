import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import {
  LOCALE_COOKIE,
  isSupportedLocale,
  type SupportedLocale,
} from "@/lib/i18n/locales"

export async function POST(request: Request) {
  const { locale } = (await request.json()) as { locale?: string }

  if (!locale || !isSupportedLocale(locale)) {
    return jsonError("Unsupported locale", 400)
  }

  const response = NextResponse.json({ locale: locale as SupportedLocale })
  response.cookies.set(LOCALE_COOKIE, locale, {
    httpOnly: false,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  })

  return response
}
