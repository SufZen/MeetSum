import type { Metadata } from "next"

import "../../globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { getShareDocumentLocale } from "@/lib/sharing/share-locale"
import { fontVariables } from "@/lib/fonts"
import { cn } from "@/lib/utils"

import { loadShare } from "./load-share"

export const metadata: Metadata = {
  title: "MeetSum shared meeting",
  robots: { index: false, follow: false },
}

/**
 * Root layout for public share links. `/share/*` lives outside
 * `app/[locale]`, so it needs its own <html>/<body>, global styles, fonts and
 * theme. Document language/direction follow the shared meeting's language.
 */
export default async function ShareLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode
  params: Promise<{ token: string }>
}>) {
  const { token } = await params
  const result = await loadShare(token)
  const { lang, dir } = getShareDocumentLocale(result?.meeting)

  return (
    <html
      lang={lang}
      dir={dir}
      suppressHydrationWarning
      className={cn("antialiased", fontVariables)}
    >
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  )
}
