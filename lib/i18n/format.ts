/**
 * The only module allowed to call Intl.DateTimeFormat / NumberFormat /
 * RelativeTimeFormat or toLocale*String (M9, docs/parity/m9.md "Formatting
 * API"; enforced by the check.mjs `locale-format` rule). Every formatter takes
 * an explicit time zone (the `Fmt` type requires it), Western digits and the
 * Gregorian calendar; Hebrew uses a 24-hour clock.
 *
 * Step 0 ships the real, minimal implementation; Package A completes the
 * Hebrew phrasing (relative "אתמול ב־14:30", month abbreviations, DST tests).
 */

export type FmtLocale = "he" | "en"

export type Fmt = { locale: FmtLocale; timeZone: string }

export type DateStyle = "date" | "dateShort" | "dateTime" | "time" | "weekdayDate" | "monthYear"

export type DurationStyle = "long" | "short" | "clock"

export type CountForms = { one: string; two?: string; other: string }

export type DateInput = Date | string | number

const DATE_STYLES: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  date: { year: "numeric", month: "short", day: "numeric" },
  dateShort: { year: "2-digit", month: "numeric", day: "numeric" },
  dateTime: { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" },
  time: { hour: "2-digit", minute: "2-digit" },
  weekdayDate: { weekday: "long", month: "short", day: "numeric" },
  monthYear: { year: "numeric", month: "long" },
}

function toDate(value: DateInput): Date {
  return value instanceof Date ? value : new Date(value)
}

function baseDateOptions(fmt: Fmt): Intl.DateTimeFormatOptions {
  return {
    timeZone: fmt.timeZone,
    numberingSystem: "latn",
    calendar: "gregory",
    ...(fmt.locale === "he" ? { hourCycle: "h23" as const } : {}),
  }
}

export function formatDate(value: DateInput, fmt: Fmt, style: DateStyle = "date"): string {
  const date = toDate(value)

  if (Number.isNaN(date.getTime())) return ""

  return new Intl.DateTimeFormat(fmt.locale, { ...baseDateOptions(fmt), ...DATE_STYLES[style] }).format(date)
}

/**
 * Relative time against an explicit `now` (hydration-safe: render the
 * absolute value on the server and switch after mount via `useNow`).
 */
export function formatRelative(value: DateInput, now: Date, fmt: Fmt): string {
  const date = toDate(value)

  if (Number.isNaN(date.getTime())) return ""

  const seconds = Math.round((date.getTime() - now.getTime()) / 1000)
  const abs = Math.abs(seconds)
  const rtf = new Intl.RelativeTimeFormat(fmt.locale, { numeric: "auto", numberingSystem: "latn" } as Intl.RelativeTimeFormatOptions)

  if (abs < 45) return rtf.format(0, "second")
  if (abs < 45 * 60) return rtf.format(Math.round(seconds / 60), "minute")
  if (abs < 22 * 3600) return rtf.format(Math.round(seconds / 3600), "hour")
  if (abs < 7 * 86400) return rtf.format(Math.round(seconds / 86400), "day")

  return formatDate(date, fmt, "date")
}

function heUnit(n: number, one: string, two: string, many: string): string {
  if (n === 1) return one
  if (n === 2) return two
  return `${n} ${many}`
}

export function formatDuration(ms: number, fmt: Fmt, style: DurationStyle = "long"): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0

  if (style === "clock") return formatTimecode(safe)

  const totalSeconds = Math.round(safe / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (fmt.locale === "he") {
    if (hours === 0 && minutes === 0) {
      return style === "short" ? `${seconds} ש׳` : heUnit(seconds, "שנייה", "שתי שניות", "שניות")
    }

    if (style === "short") {
      return [hours ? `${hours} ש׳` : "", minutes ? `${minutes} דק׳` : ""].filter(Boolean).join(" ")
    }

    const parts = [
      hours ? heUnit(hours, "שעה", "שעתיים", "שעות") : "",
      minutes ? heUnit(minutes, "דקה", "שתי דקות", "דקות") : "",
    ].filter(Boolean)

    return parts.length === 2 ? `${parts[0]} ו־${parts[1]}` : parts[0]!
  }

  if (hours === 0 && minutes === 0) return style === "short" ? `${seconds}s` : `${seconds} sec`

  if (style === "short") return [hours ? `${hours}h` : "", minutes ? `${minutes}m` : ""].filter(Boolean).join(" ")

  return [hours ? `${hours} hr` : "", minutes ? `${minutes} min` : ""].filter(Boolean).join(" ")
}

export function formatNumber(n: number, fmt: Fmt, opts: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(fmt.locale, { numberingSystem: "latn", ...opts } as Intl.NumberFormatOptions).format(n)
}

export function formatPercent(ratio: number, fmt: Fmt): string {
  return formatNumber(ratio, fmt, { style: "percent", maximumFractionDigits: 0 })
}

/**
 * Plural-aware count: `Intl.PluralRules` one/two/other (he has a dual).
 * `{count}` in a form is replaced by the formatted number.
 */
export function formatCount(n: number, fmt: Fmt, forms: CountForms): string {
  const category = new Intl.PluralRules(fmt.locale).select(n)
  const form = category === "one" ? forms.one : category === "two" ? (forms.two ?? forms.other) : forms.other

  return form.replace(/\{count\}/g, formatNumber(n, fmt))
}

/** "12:34" / "1:02:03", Western digits, never localized. */
export function formatTimecode(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const pad = (value: number) => String(value).padStart(2, "0")

  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}
