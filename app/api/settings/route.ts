import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { getAppSettings, updateAppSettings } from "@/lib/settings/app-settings"
import { LOCALE_COOKIE } from "@/lib/i18n/locales"

export async function GET(request: Request) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  return NextResponse.json({ settings: await getAppSettings() })
}

export async function PATCH(request: Request) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  try {
    const patch = (await request.json()) as Record<string, unknown>
    const settings = await updateAppSettings(patch)
    const response = NextResponse.json({ settings })

    response.cookies.set(LOCALE_COOKIE, settings.defaultLocale, {
      httpOnly: false,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    })

    return response
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Unable to update settings",
      400
    )
  }
}
