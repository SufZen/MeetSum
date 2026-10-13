import type { Metadata } from "next"
import { Geist_Mono, Inter, Noto_Sans_Hebrew } from "next/font/google"

import "../../globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { getShareDocumentLocale } from "@/lib/sharing/share-locale"
import { cn } from "@/lib/utils"

import { loadShare } from "./load-share"

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" })
const notoHebrew = Noto_Sans_Hebrew({
  subsets: ["hebrew"],
  variable: "--font-hebrew",
})
const fontMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
})

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
      className={cn(
        "antialiased",
        fontMono.variable,
        inter.variable,
        notoHebrew.variable,
        lang === "he" ? "font-hebrew" : "font-sans"
      )}
    >
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  )
}
