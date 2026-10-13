"use client"

/**
 * Client i18n context (M9 Step 0, docs/parity/m9.md item 3; owner: Package A).
 * Mounted by `app/[locale]/layout.tsx` and `app/share/[token]/layout.tsx`
 * with the values from `getRequestI18n()`. Existing `dictionary` props keep
 * working; new code reads `useI18n()` instead of importing `dictionaries`.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react"

import {
  formatCount,
  formatDate,
  formatDuration,
  formatNumber,
  formatPercent,
  formatRelative,
  type CountForms,
  type DateInput,
  type DateStyle,
  type DurationStyle,
  type Fmt,
} from "@/lib/i18n/format"
import { directionFor, fixHebrewTypography } from "@/lib/i18n/hebrew-text"
import { pluralMessage, translate, type MessageSource, type MessageValues } from "@/lib/i18n/messages"
import type { SupportedLocale } from "@/lib/i18n/locales"

export type I18nValue = {
  locale: SupportedLocale
  dir: "rtl" | "ltr"
  timeZone: string
  t: (key: string, values?: MessageValues) => string
  plural: (key: string, n: number, values?: MessageValues) => string
  fmt: {
    date: (value: DateInput, style?: DateStyle) => string
    relative: (value: DateInput, now: Date) => string
    duration: (ms: number, style?: DurationStyle) => string
    number: (n: number, opts?: Intl.NumberFormatOptions) => string
    percent: (ratio: number) => string
    count: (n: number, forms: CountForms) => string
  }
  /** Display-time Hebrew typesetting; `lang` is the content language when known. */
  text: (s: string, lang?: string | null) => string
}

function buildValue(locale: SupportedLocale, dir: "rtl" | "ltr", timeZone: string, messages: MessageSource): I18nValue {
  const f: Fmt = { locale, timeZone }

  return {
    locale,
    dir,
    timeZone,
    t: (key, values) => translate(messages, key, values),
    plural: (key, n, values) => pluralMessage(messages, locale, key, n, values),
    fmt: {
      date: (value, style) => formatDate(value, f, style),
      relative: (value, now) => formatRelative(value, now, f),
      duration: (ms, style) => formatDuration(ms, f, style),
      number: (n, opts) => formatNumber(n, f, opts),
      percent: (ratio) => formatPercent(ratio, f),
      count: (n, forms) => formatCount(n, f, forms),
    },
    text: (s, lang) => fixHebrewTypography(s, { base: directionFor(lang ?? locale, s) }),
  }
}

const I18nContext = createContext<I18nValue | null>(null)

export function I18nProvider({
  locale,
  dir,
  timeZone,
  messages,
  children,
}: {
  locale: SupportedLocale
  dir: "rtl" | "ltr"
  timeZone: string
  /** The active locale's dictionary (or the slice this subtree needs). */
  messages: MessageSource
  children: ReactNode
}) {
  const value = useMemo(() => buildValue(locale, dir, timeZone, messages), [locale, dir, timeZone, messages])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

/** Throws outside an `I18nProvider` (every app layout mounts one). */
export function useI18n(): I18nValue {
  const value = useContext(I18nContext)

  if (!value) throw new Error("useI18n must be used inside I18nProvider") // i18n-allow: developer error

  return value
}

/**
 * Current time after mount, `null` during SSR and hydration, so relative
 * times render the absolute value first and never mismatch.
 */
export function useNow(intervalMs = 60_000): Date | null {
  const [now, setNow] = useState<Date | null>(null)

  useEffect(() => {
    const tick = () => setNow(new Date())
    const first = window.setTimeout(tick, 0)
    const id = window.setInterval(tick, intervalMs)

    return () => {
      window.clearTimeout(first)
      window.clearInterval(id)
    }
  }, [intervalMs])

  return now
}
