"use client"

import { usePathname, useRouter } from "next/navigation"

import {
  SUPPORTED_LOCALES,
  replacePathLocale,
  type SupportedLocale,
} from "@/lib/i18n/locales"

const localeLabels: Record<SupportedLocale, string> = {
  en: "EN",
  he: "HE",
  pt: "PT",
  es: "ES",
  it: "IT",
}

export function LanguageSwitcher({ locale }: { locale: SupportedLocale }) {
  const pathname = usePathname()
  const router = useRouter()

  async function switchLocale(nextLocale: SupportedLocale) {
    await fetch("/api/user/locale", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ locale: nextLocale }),
    })
    router.push(replacePathLocale(pathname, nextLocale))
  }

  return (
    <div className="inline-grid h-9 grid-cols-5 rounded-md border bg-card p-0.5">
      {SUPPORTED_LOCALES.map((item) => (
        <button
          key={item}
          type="button"
          onClick={() => switchLocale(item)}
          className="min-w-9 rounded-sm px-2 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[active=true]:bg-primary data-[active=true]:text-primary-foreground"
          data-active={item === locale}
          aria-pressed={item === locale}
        >
          {localeLabels[item]}
        </button>
      ))}
    </div>
  )
}
