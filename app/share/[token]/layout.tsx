import type { Metadata } from "next"
import { cookies, headers } from "next/headers"

import "../../globals.css"
import { I18nProvider } from "@/components/i18n-provider"
import { ThemeProvider } from "@/components/theme-provider"
import { DirectionProvider } from "@/components/ui/direction"
import { clipShareLocale } from "@/lib/clips/share-payload"
import { fontVariables } from "@/lib/fonts"
import { LOCALE_COOKIE, type SupportedLocale } from "@/lib/i18n/locales"
import { m9ShareMessages } from "@/lib/i18n/m9/share"
import { resolveTimeZone } from "@/lib/i18n/time-zone"
import { getShareDocumentLocale } from "@/lib/sharing/share-locale"
import { resolveShareViewerLocale, shareLocaleDir } from "@/lib/sharing/share-viewer-locale"
import { cn } from "@/lib/utils"

import { loadClipShare, loadShare } from "./load-share"

/** Share pages read cookies (password gate, language) and are never cached. */
export const dynamic = "force-dynamic"

/** The meeting's (or clip's) language, used only as a chrome fallback. */
async function meetingLocale(token: string): Promise<SupportedLocale> {
  const clip = await loadClipShare(token)

  if (clip.kind === "clip") return clipShareLocale(clip.view.meeting.language).lang
  if (clip.kind === "clip_unavailable") return getShareDocumentLocale(undefined).lang

  return getShareDocumentLocale((await loadShare(token))?.meeting).lang
}

/** Viewer chrome locale without `?lang=` (layouts get no search params). */
async function chromeLocale(token: string): Promise<SupportedLocale> {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()])

  return resolveShareViewerLocale({
    cookie: cookieStore.get(LOCALE_COOKIE)?.value,
    acceptLanguage: headerStore.get("accept-language"),
    meetingLocale: await meetingLocale(token),
  })
}

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const locale = await chromeLocale((await params).token)

  return {
    title: m9ShareMessages[locale].sharePageTitle,
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  }
}

/**
 * Root layout for public share links. `/share/*` lives outside
 * `app/[locale]`, so it needs its own <html>/<body>, global styles, fonts and
 * theme. `<html lang dir>` follow the **viewer** (M9 B7: cookie →
 * Accept-Language → meeting language → he; the page also honours `?lang=`);
 * content blocks keep the meeting or segment language. The provider gets
 * only the share messages (loading, error and not-found read them).
 */
export default async function ShareLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode
  params: Promise<{ token: string }>
}>) {
  const locale = await chromeLocale((await params).token)
  const dir = shareLocaleDir(locale)

  return (
    <html lang={locale} dir={dir} suppressHydrationWarning className={cn("antialiased", fontVariables)}>
      <body>
        <DirectionProvider direction={dir}>
          <I18nProvider
            locale={locale}
            dir={dir}
            timeZone={resolveTimeZone({ env: process.env.MEETSUM_DEFAULT_TIMEZONE })}
            messages={m9ShareMessages[locale]}
          >
            <ThemeProvider>{children}</ThemeProvider>
          </I18nProvider>
        </DirectionProvider>
      </body>
    </html>
  )
}
