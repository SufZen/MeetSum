/**
 * Global 404 for URLs no route matches and for an unsupported locale
 * segment (the `[locale]` layout calls `notFound()`): the app has no single
 * root layout, so this page carries its own Hebrew RTL document (the default
 * locale) with an English line, instead of Next's default English page.
 * Enabled by `experimental.globalNotFound` in next.config.mjs.
 */
import "./globals.css"

import type { Metadata } from "next"

import { fontVariables } from "@/lib/fonts"
import { m9ShellMessages } from "@/lib/i18n/m9/shell"
import { cn } from "@/lib/utils"

const he = m9ShellMessages.he
const en = m9ShellMessages.en

export const metadata: Metadata = {
  title: `${he.shellNotFoundTitle} · MeetSum`,
}

export default function GlobalNotFound() {
  return (
    <html lang="he" dir="rtl" className={cn("antialiased", fontVariables)}>
      <body className="grid min-h-svh place-items-center bg-canvas p-6 text-foreground">
        <main className="flex max-w-md flex-col items-center gap-3 text-center">
          <h1 className="text-xl font-semibold">{he.shellNotFoundTitle}</h1>
          <p className="text-sm text-muted-foreground">{he.shellNotFoundDescription}</p>
          <p lang="en" dir="ltr" className="text-sm text-muted-foreground">
            {en.shellNotFoundTitle}. {en.shellNotFoundDescription}
          </p>
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- outside any locale layout; "/" resolves the locale */}
          <a
            href="/"
            className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
          >
            {he.shellNotFoundAction}
          </a>
        </main>
      </body>
    </html>
  )
}
