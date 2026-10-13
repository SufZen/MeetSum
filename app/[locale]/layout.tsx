import type { Metadata } from "next"
import { redirect } from "next/navigation"

import "../globals.css"
import { I18nProvider } from "@/components/i18n-provider"
import { ServiceWorkerRegistrar } from "@/components/pwa/service-worker-registrar"
import { ThemeProvider } from "@/components/theme-provider"
import { DirectionProvider } from "@/components/ui/direction"
import { Toaster } from "@/components/ui/sonner"
import {
  DEFAULT_LOCALE,
  getLocaleDirection,
  isSupportedLocale,
  type SupportedLocale,
} from "@/lib/i18n/locales"
import { fontVariables } from "@/lib/fonts"
import { getRequestI18n } from "@/lib/i18n/server"
import { cn } from "@/lib/utils"

export const metadata: Metadata = {
  title: "MeetSum",
  description: "Self-hosted AI-first meeting summaries for Google Workspace.",
}

export default async function LocaleLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode
  params: Promise<{ locale: string }>
}>) {
  const { locale } = await params

  // A path the proxy let through with an unsupported first segment (e.g.
  // `/xx/file.php`): send it into the default locale, where the catch-all
  // renders the localized 404 (a notFound() here would bypass every
  // localized boundary and show Next's default English page).
  if (!isSupportedLocale(locale)) {
    redirect(`/${DEFAULT_LOCALE}/${encodeURIComponent(locale)}`)
  }

  const supportedLocale = locale as SupportedLocale
  const dir = getLocaleDirection(supportedLocale)
  const i18n = await getRequestI18n({ locale: supportedLocale })

  return (
    <html
      lang={supportedLocale}
      dir={dir}
      suppressHydrationWarning
      className={cn("antialiased", fontVariables)}
    >
      <body>
        {/* M9 D7: first focusable element; the shell's <main> has this id. */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:start-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:shadow-3"
        >
          {i18n.dictionary.shellSkipToContent}
        </a>
        <DirectionProvider direction={dir}>
          <I18nProvider locale={i18n.locale} dir={i18n.dir} timeZone={i18n.timeZone} messages={i18n.dictionary}>
            <ThemeProvider>
              {children}
              <Toaster dir={dir} richColors containerAriaLabel={i18n.dictionary.shellToastRegionLabel} />
              <ServiceWorkerRegistrar />
            </ThemeProvider>
          </I18nProvider>
        </DirectionProvider>
      </body>
    </html>
  )
}
