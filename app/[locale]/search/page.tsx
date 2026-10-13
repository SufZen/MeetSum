import { redirect } from "next/navigation"

import { getServerAuthState } from "@/lib/auth/authz"
import { isSupportedLocale, type SupportedLocale } from "@/lib/i18n/locales"

/**
 * Global Search & Ask page (docs/parity/m6.md, D1; owner: Package D).
 * STEP 0 STUB: auth redirect as in the Tasks page, empty body.
 */
export default async function SearchPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  const supportedLocale: SupportedLocale = isSupportedLocale(locale) ? locale : "en"
  const auth = await getServerAuthState()

  if (auth.status === "unauthenticated") redirect(`/${supportedLocale}/login`)
  if (auth.status === "no_workspace") redirect(`/${supportedLocale}`)

  return <main className="min-h-svh bg-canvas" />
}
