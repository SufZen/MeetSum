import { ArrowLeftIcon } from "lucide-react"
import Link from "next/link"
import { redirect } from "next/navigation"

import { getServerAuthState } from "@/lib/auth/authz"
import { getDictionary } from "@/lib/i18n/dictionaries"
import { DEFAULT_LOCALE, isSupportedLocale, type SupportedLocale } from "@/lib/i18n/locales"

/**
 * Workspace analytics dashboard (docs/parity/m9.md C2).
 * M9 Step 0 stub behind its final guard (signed in, with a workspace);
 * owner: Package C.
 */
export default async function AnalyticsPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  const supportedLocale: SupportedLocale = isSupportedLocale(locale) ? locale : DEFAULT_LOCALE
  const auth = await getServerAuthState()

  if (auth.status === "unauthenticated") redirect(`/${supportedLocale}/login`)
  if (auth.status === "no_workspace") redirect(`/${supportedLocale}`)

  const dictionary = getDictionary(supportedLocale)

  return (
    <main className="min-h-svh bg-canvas">
      <div className="mx-auto grid w-full max-w-3xl gap-4 px-4 pt-4">
        <Link
          href={`/${supportedLocale}`}
          className="inline-flex items-center gap-1.5 text-sm text-fg-3 hover:text-brand-text"
        >
          <ArrowLeftIcon aria-hidden data-icon="directional" className="size-3.5 rtl:-scale-x-100" />
          {dictionary.navMeetings}
        </Link>
        <h1 className="text-xl font-semibold">{dictionary.analyticsTitle}</h1>
      </div>
    </main>
  )
}
