"use client"

import { usePathname, useRouter } from "next/navigation"
import { useTransition } from "react"

import { useOptionalI18n } from "@/components/i18n-provider"
import { SUPPORTED_LOCALES, replacePathLocale, type SupportedLocale } from "@/lib/i18n/locales"

const SHORT_LABELS: Record<SupportedLocale, string> = {
  he: "HE",
  en: "EN",
}

const NAME_KEYS: Record<SupportedLocale, string> = {
  he: "settingsLanguageHebrew",
  en: "settingsLanguageEnglish",
}

/** Persists the choice (cookie, plus `users.locale` with a session) and moves to the same page in the new locale. */
export async function persistLocaleChoice(locale: SupportedLocale): Promise<void> {
  await fetch("/api/user/locale", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ locale }),
  }).catch(() => undefined)
}

export function LanguageSwitcher({ locale }: { locale: SupportedLocale }) {
  const pathname = usePathname()
  const router = useRouter()
  const i18n = useOptionalI18n()
  const [pending, startTransition] = useTransition()

  function switchLocale(nextLocale: SupportedLocale) {
    if (nextLocale === locale) return

    startTransition(async () => {
      await persistLocaleChoice(nextLocale)
      // Keep the shell state (?panel=…&section=…) across the switch.
      router.push(`${replacePathLocale(pathname, nextLocale)}${window.location.search}`)
    })
  }

  return (
    <div
      role="group"
      aria-label={i18n?.t("settingsInterfaceLanguage") ?? SHORT_LABELS[locale]}
      aria-busy={pending}
      className="inline-grid h-9 grid-cols-2 rounded-md border bg-card p-0.5"
    >
      {SUPPORTED_LOCALES.map((item) => (
        <button
          key={item}
          type="button"
          lang={item}
          onClick={() => switchLocale(item)}
          className="min-w-9 rounded-sm px-2 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[active=true]:bg-primary data-[active=true]:text-primary-foreground"
          data-active={item === locale}
          aria-pressed={item === locale}
          aria-label={i18n?.t(NAME_KEYS[item]) ?? SHORT_LABELS[item]}
          disabled={pending}
        >
          {SHORT_LABELS[item]}
        </button>
      ))}
    </div>
  )
}
