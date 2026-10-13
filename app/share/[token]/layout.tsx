import type { Metadata } from "next"

import "../../globals.css"
import { I18nProvider } from "@/components/i18n-provider"
import { ThemeProvider } from "@/components/theme-provider"
import { DirectionProvider } from "@/components/ui/direction"
import { clipShareLocale } from "@/lib/clips/share-payload"
import { getShareDocumentLocale } from "@/lib/sharing/share-locale"
import { fontVariables } from "@/lib/fonts"
import { getRequestI18n } from "@/lib/i18n/server"
import { cn } from "@/lib/utils"

import { loadClipShare, loadShare } from "./load-share"

export const metadata: Metadata = {
  title: "MeetSum shared meeting",
  robots: { index: false, follow: false },
}

/**
 * Root layout for public share links. `/share/*` lives outside
 * `app/[locale]`, so it needs its own <html>/<body>, global styles, fonts and
 * theme. Document language/direction follow the shared meeting's language
 * (for a clip share: the clip's meeting language).
 */
export default async function ShareLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode
  params: Promise<{ token: string }>
}>) {
  const { token } = await params
  const clip = await loadClipShare(token)
  const { lang, dir } =
    clip.kind === "clip"
      ? clipShareLocale(clip.view.meeting.language)
      : clip.kind === "clip_unavailable"
        ? getShareDocumentLocale(undefined)
        : getShareDocumentLocale((await loadShare(token))?.meeting)
  // Viewer chrome locale (Package B refines: ?lang= → cookie → header → meeting).
  const i18n = await getRequestI18n()

  return (
    <html
      lang={lang}
      dir={dir}
      suppressHydrationWarning
      className={cn("antialiased", fontVariables)}
    >
      <body>
        <DirectionProvider direction={dir}>
          <I18nProvider locale={i18n.locale} dir={i18n.dir} timeZone={i18n.timeZone} messages={i18n.dictionary}>
            <ThemeProvider>{children}</ThemeProvider>
          </I18nProvider>
        </DirectionProvider>
      </body>
    </html>
  )
}
