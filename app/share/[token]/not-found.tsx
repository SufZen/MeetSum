import { LinkIcon } from "lucide-react"
import { cookies, headers } from "next/headers"
import Link from "next/link"

import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { LOCALE_COOKIE } from "@/lib/i18n/locales"
import { m9ShareMessages } from "@/lib/i18n/m9/share"
import { resolveShareViewerLocale, shareLocaleDir } from "@/lib/sharing/share-viewer-locale"

/**
 * Unknown, revoked, expired or disabled share link (M9 B7). It never says
 * which: every failed gate looks the same. Σ empty state with one action.
 */
export default async function ShareNotFound() {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()])
  const locale = resolveShareViewerLocale({
    cookie: cookieStore.get(LOCALE_COOKIE)?.value,
    acceptLanguage: headerStore.get("accept-language"),
  })
  const t = m9ShareMessages[locale]

  return (
    <main lang={locale} dir={shareLocaleDir(locale)} className="grid min-h-screen place-items-center bg-canvas px-4 py-8 text-fg">
      <Empty className="max-w-md">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <LinkIcon aria-hidden />
          </EmptyMedia>
          <EmptyTitle>
            <h1>{t.sharePageNotFound}</h1>
          </EmptyTitle>
          <EmptyDescription>{t.sharePageNotFoundHint}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Link href="/" className="text-sm font-medium text-brand-text underline-offset-4 hover:underline">
            {t.sharePageGoHome}
          </Link>
        </EmptyContent>
      </Empty>
    </main>
  )
}
