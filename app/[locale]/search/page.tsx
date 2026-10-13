import { Suspense } from "react"
import { ArrowLeftIcon } from "lucide-react"
import Link from "next/link"
import { redirect } from "next/navigation"

import { SearchView } from "@/components/search/search-view"
import { getServerAuthState } from "@/lib/auth/authz"
import { getDictionary } from "@/lib/i18n/dictionaries"
import { isSupportedLocale, type SupportedLocale } from "@/lib/i18n/locales"

/** Global Search & Ask page (docs/parity/m6.md, D1). */
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

  const { ctx } = auth
  const dictionary = getDictionary(supportedLocale)
  const rooms = await ctx.meetings.listRooms().catch(() => [])

  return (
    <main className="min-h-svh bg-canvas">
      <div className="mx-auto w-full max-w-4xl px-4 pt-4">
        <Link
          href={`/${supportedLocale}`}
          className="inline-flex items-center gap-1.5 text-sm text-fg-3 hover:text-brand-text"
        >
          <ArrowLeftIcon aria-hidden data-icon="directional" className="size-3.5 rtl:-scale-x-100" />
          {dictionary.navMeetings}
        </Link>
      </div>
      <Suspense fallback={<div aria-busy="true" className="mx-auto h-40 w-full max-w-4xl px-4" />}>
        <SearchView
          locale={supportedLocale}
          dictionary={dictionary}
          rooms={rooms.map((room) => ({ id: room.id, name: room.name }))}
        />
      </Suspense>
    </main>
  )
}
