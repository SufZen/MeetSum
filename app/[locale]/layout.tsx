import type { Metadata } from "next"
import { notFound } from "next/navigation"

import "../globals.css"
import { I18nProvider } from "@/components/i18n-provider"
import { ServiceWorkerRegistrar } from "@/components/pwa/service-worker-registrar"
import { ThemeProvider } from "@/components/theme-provider"
import { DirectionProvider } from "@/components/ui/direction"
import { Toaster } from "@/components/ui/sonner"
import {
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

  if (!isSupportedLocale(locale)) {
    notFound()
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
        <DirectionProvider direction={dir}>
          <I18nProvider locale={i18n.locale} dir={i18n.dir} timeZone={i18n.timeZone} messages={i18n.dictionary}>
            <ThemeProvider>
              {children}
              <Toaster dir={dir} richColors />
              <ServiceWorkerRegistrar />
            </ThemeProvider>
          </I18nProvider>
        </DirectionProvider>
      </body>
    </html>
  )
}
