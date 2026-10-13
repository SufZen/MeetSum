/**
 * The only module allowed to call Intl.DateTimeFormat / NumberFormat /
 * RelativeTimeFormat or toLocale*String (M9, docs/parity/m9.md "Formatting
 * API"; enforced by the check.mjs `locale-format` rule). Every formatter takes
 * an explicit time zone (the `Fmt` type requires it), Western digits and the
 * Gregorian calendar; Hebrew uses a 24-hour clock.
 */

export type FmtLocale = "he" | "en"

export type Fmt = { locale: FmtLocale; timeZone: string }

export type DateStyle =
  | "date"
  | "dateShort"
  | "dateLong"
  | "dateTime"
  | "dateTimeLong"
  | "time"
  | "weekdayDate"
  | "monthYear"

export type DurationStyle = "long" | "short" | "clock"

export type CountForms = { one: string; two?: string; other: string }

export type DateInput = Date | string | number

const DATE_STYLES: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  date: { year: "numeric", month: "short", day: "numeric" },
  dateShort: { year: "2-digit", month: "numeric", day: "numeric" },
  dateLong: { year: "numeric", month: "long", day: "numeric" },
  dateTime: { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" },
  dateTimeLong: { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" },
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

  const options = DATE_STYLES[style]
  // Hebrew pads the 24-hour clock ("09:00"); English uses "9:00 AM".
  const hour = options.hour && fmt.locale === "en" ? { hour: "numeric" as const } : {}

  return new Intl.DateTimeFormat(fmt.locale, { ...baseDateOptions(fmt), ...options, ...hour }).format(date)
}

type ZonedDay = { y: number; m: number; d: number }

function zonedDay(date: Date, timeZone: string): ZonedDay {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    numberingSystem: "latn",
    calendar: "gregory",
  }).formatToParts(date)
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0)

  return { y: pick("year"), m: pick("month"), d: pick("day") }
}

/** Whole calendar days from `a` to `b` in `timeZone` (DST-safe: compares dates, not hours). */
function calendarDayDiff(a: Date, b: Date, timeZone: string): number {
  const da = zonedDay(a, timeZone)
  const db = zonedDay(b, timeZone)

  return Math.round((Date.UTC(db.y, db.m - 1, db.d) - Date.UTC(da.y, da.m - 1, da.d)) / 86_400_000)
}

function heCount(n: number, one: string, two: string, many: string): string {
  if (n === 1) return one
  if (n === 2) return two
  return `${n} ${many}`
}

function relativeUnit(n: number, unit: "minute" | "hour", past: boolean, fmt: Fmt): string {
  if (fmt.locale === "he") {
    const phrase =
      unit === "minute" ? heCount(n, "דקה", "שתי דקות", "דקות") : heCount(n, "שעה", "שעתיים", "שעות")

    return past ? `לפני ${phrase}` : `בעוד ${phrase}`
  }

  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto", numberingSystem: "latn" } as Intl.RelativeTimeFormatOptions)

  return rtf.format(past ? -n : n, unit)
}

function dayAtTime(day: string, date: Date, fmt: Fmt): string {
  const time = formatDate(date, fmt, "time")

  return fmt.locale === "he" ? `${day} ב־${time}` : `${day} at ${time}`
}

/**
 * Relative time against an explicit `now` (hydration-safe: render the
 * absolute value on the server and switch after mount via `useNow`).
 * he: "עכשיו", "לפני דקה", "לפני 5 דקות", "לפני שעתיים", "אתמול ב־14:30",
 * "יום שלישי ב־09:00" (under 7 days), else "13 באוק׳ 2026".
 * en: "now", "5 minutes ago", "2 hours ago", "Yesterday at 2:30 PM",
 * "Tuesday at 9:00 AM", else "Oct 13, 2026". Calendar days are counted in
 * `fmt.timeZone`.
 */
export function formatRelative(value: DateInput, now: Date, fmt: Fmt): string {
  const date = toDate(value)

  if (Number.isNaN(date.getTime())) return ""

  const seconds = Math.round((now.getTime() - date.getTime()) / 1000)
  const past = seconds >= 0
  const abs = Math.abs(seconds)

  if (abs < 45) return fmt.locale === "he" ? "עכשיו" : "now"
  if (abs < 45 * 60) return relativeUnit(Math.max(1, Math.round(abs / 60)), "minute", past, fmt)

  const dayDiff = calendarDayDiff(date, now, fmt.timeZone)

  if (dayDiff === 0 || (!past && abs < 22 * 3600)) {
    return relativeUnit(Math.max(1, Math.round(abs / 3600)), "hour", past, fmt)
  }

  if (past && dayDiff === 1) return dayAtTime(fmt.locale === "he" ? "אתמול" : "Yesterday", date, fmt)

  if (past && dayDiff > 1 && dayDiff < 7) {
    const weekday = new Intl.DateTimeFormat(fmt.locale, { ...baseDateOptions(fmt), weekday: "long" }).format(date)

    return dayAtTime(weekday, date, fmt)
  }

  return formatDate(date, fmt, "date")
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
      return style === "short" ? `${seconds} ש׳` : heCount(seconds, "שנייה", "שתי שניות", "שניות")
    }

    if (style === "short") {
      return [hours ? `${hours} ש׳` : "", minutes ? `${minutes} דק׳` : ""].filter(Boolean).join(" ")
    }

    const parts = [
      hours ? heCount(hours, "שעה", "שעתיים", "שעות") : "",
      minutes ? heCount(minutes, "דקה", "שתי דקות", "דקות") : "",
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

/**
 * Formats a date-only value (`YYYY-MM-DD`, e.g. a due date) without any zone
 * shift: the calendar day is the value itself.
 */
export function formatDateOnly(isoDate: string, locale: FmtLocale, style: DateStyle = "date"): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate)

  if (!match) return isoDate

  const noonUtc = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12))

  return formatDate(noonUtc, { locale, timeZone: "UTC" }, style)
}

export type ZonedParts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/** Numeric calendar fields of an instant in `timeZone` (machine use: keys, offsets, prompts). */
export function zonedParts(value: DateInput, timeZone: string): ZonedParts | undefined {
  const date = toDate(value)

  if (Number.isNaN(date.getTime())) return undefined

  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
      numberingSystem: "latn",
      calendar: "gregory",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value])
  ) as Record<string, string>

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAY_INDEX[parts.weekday ?? ""] ?? 0,
  }
}

const pad2 = (n: number) => String(n).padStart(2, "0")

/** `YYYY-MM-DD` of an instant in `timeZone`, or "" for invalid input. */
export function formatIsoDate(value: DateInput, timeZone: string): string {
  const parts = zonedParts(value, timeZone)

  return parts ? `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}` : ""
}

/** `DD.MM.YYYY` of an instant in `timeZone` (prompts, search metadata), or "" for invalid input. */
export function formatNumericDate(value: DateInput, timeZone: string): string {
  const parts = zonedParts(value, timeZone)

  return parts ? `${pad2(parts.day)}.${pad2(parts.month)}.${parts.year}` : ""
}

/** Milliseconds `timeZone` is ahead of UTC at `instant`. */
export function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone)

  if (!parts) return 0

  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)

  return asUtc - Math.floor(instant.getTime() / 1000) * 1000
}

const BYTE_UNITS = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"] as const

/** "1.5 MB" / "1.5 מ״ב" (binary multiples, one decimal above bytes). */
export function formatBytes(bytes: number, fmt: Fmt): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  const index = safe ? Math.min(Math.floor(Math.log(safe) / Math.log(1024)), BYTE_UNITS.length - 1) : 0

  return formatNumber(safe / 1024 ** index, fmt, {
    style: "unit",
    unit: BYTE_UNITS[index],
    unitDisplay: "short",
    maximumFractionDigits: index === 0 ? 0 : 1,
  })
}

/** The runtime's own IANA zone (the browser's, client-side), for "use the browser time zone". */
export function systemTimeZone(): string {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}
