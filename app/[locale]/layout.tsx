import type { Metadata } from "next"
import { notFound } from "next/navigation"

import "../globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/sonner"
import {
  getLocaleDirection,
  isSupportedLocale,
  type SupportedLocale,
} from "@/lib/i18n/locales"
import { fontVariables } from "@/lib/fonts"
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

  return (
    <html
      lang={supportedLocale}
      dir={getLocaleDirection(supportedLocale)}
      suppressHydrationWarning
      className={cn("antialiased", fontVariables)}
    >
      <body>
        <ThemeProvider>
          {children}
          <Toaster position="top-right" richColors />
        </ThemeProvider>
      </body>
    </html>
  )
}
