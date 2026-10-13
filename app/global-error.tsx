"use client"

/**
 * Last-resort error page (M9 D3): replaces the root layout, so it has its own
 * `<html lang="he" dir="rtl">` and a bilingual message from the shell module
 * (not the full dictionary). Never shows the error message; the digest only.
 */
import "./globals.css"

import { m9ShellErrorMessages } from "@/lib/i18n/m9/shell-error"

const he = m9ShellErrorMessages.he
const en = m9ShellErrorMessages.en

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="he" dir="rtl">
      <body className="grid min-h-svh place-items-center bg-canvas p-6 text-foreground">
        <main role="alert" className="ms-card flex max-w-md flex-col items-center gap-4 p-8 text-center">
          <h1 className="text-xl font-semibold">{he.shellErrorTitle}</h1>
          <p lang="en" dir="ltr" className="text-base text-muted-foreground">
            {en.shellErrorTitle}
          </p>
          {error.digest ? (
            <p className="text-sm text-muted-foreground">
              {he.shellErrorDigest} · <span lang="en">{en.shellErrorDigest}</span>:{" "}
              <code dir="ltr" className="font-mono text-xs">
                {error.digest}
              </code>
            </p>
          ) : null}
          <div className="flex flex-wrap justify-center gap-2">
            <button
              type="button"
              onClick={reset}
              className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
            >
              {he.shellErrorRetry} · <span lang="en">{en.shellErrorRetry}</span>
            </button>
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- a full reload is the point after a root crash */}
            <a href="/" className="rounded-md border border-line px-4 py-2 text-sm font-medium">
              {he.shellErrorBackToMeetings} · <span lang="en">{en.shellErrorBackToMeetings}</span>
            </a>
          </div>
        </main>
      </body>
    </html>
  )
}
