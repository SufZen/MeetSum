"use client"

/**
 * Header controls of the public share page (M9 B7): interface language
 * (he/en) and light/dark theme. Choosing a language stores it in the
 * `meetsum_locale` cookie (the viewer's preference) and reloads with
 * `?lang=`, so the server renders the chrome in that language. When the page
 * locale differs from the layout's (a `?lang=` link), the document's
 * `lang`/`dir` follow the page.
 */
import { MoonIcon, SunIcon } from "lucide-react"
import { useTheme } from "next-themes"
import { useEffect } from "react"

import { Button } from "@/components/ui/button"
import { LOCALE_COOKIE, type SupportedLocale } from "@/lib/i18n/locales"

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365

/** Stores the viewer's language and reloads the page with `?lang=`. */
function switchLanguage(next: SupportedLocale) {
  document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`

  const url = new URL(window.location.href)

  url.searchParams.set("lang", next)
  url.searchParams.delete("error")
  window.location.assign(url.toString())
}

export type ShareChromeLabels = {
  language: string
  theme: string
  languageHe: string
  languageEn: string
}

export function ShareChromeControls({ locale, labels }: { locale: SupportedLocale; labels: ShareChromeLabels }) {
  const { resolvedTheme, setTheme } = useTheme()

  useEffect(() => {
    const root = document.documentElement

    root.lang = locale
    root.dir = locale === "he" ? "rtl" : "ltr"
  }, [locale])

  function chooseLanguage(next: SupportedLocale) {
    if (next !== locale) switchLanguage(next)
  }

  return (
    <div className="flex items-center gap-2">
      <div role="group" aria-label={labels.language} className="flex rounded-md border border-line p-0.5">
        {(["he", "en"] as const).map((option) => (
          <button
            key={option}
            type="button"
            lang={option}
            aria-pressed={option === locale}
            aria-label={option === "he" ? labels.languageHe : labels.languageEn}
            onClick={() => chooseLanguage(option)}
            className="rounded-sm px-2 py-1 font-mono text-xs text-fg-3 aria-pressed:bg-surface-2 aria-pressed:text-fg"
          >
            {option === "he" ? "HE" : "EN"}
          </button>
        ))}
      </div>
      {/* Both icons render; CSS picks one, so SSR and hydration always match. */}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={labels.theme}
        title={labels.theme}
        onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      >
        <SunIcon aria-hidden className="hidden dark:block" />
        <MoonIcon aria-hidden className="dark:hidden" />
      </Button>
    </div>
  )
}
