/**
 * Hebrew/English due-date parser (docs/parity/m5.md B1; owner: Package B).
 *
 * Pure and isomorphic (the action-item editor previews it client-side): no
 * I/O, no `Date.now()`. Every phrase is resolved against `anchor` (usually
 * the meeting start) as a calendar date in `timeZone`, so a meeting at 23:30
 * UTC on the 15th in Jerusalem anchors on the 16th.
 *
 * Israeli defaults: weeks start on Sunday, the workweek ends on Thursday
 * ("שבוע הבא" = next week's Thursday) and numeric dates are day-first.
 * Vague phrases ("אחרי החגים", "בקרוב", "ASAP") return null.
 */

export type DueDateParseOptions = {
  /** ISO datetime (or `YYYY-MM-DD`) the phrase is relative to. */
  anchor: string
  /** IANA zone; default `Asia/Jerusalem`. */
  timeZone?: string
  /** 0 = Sunday (default). */
  weekStart?: number
  /** Last workday; 4 = Thursday (default). */
  workweekEnd?: number
  /** Numeric date order for non-Hebrew text; default `DMY`. Hebrew is always DMY. */
  dateOrder?: "DMY" | "MDY"
  /**
   * User-typed input: reject the phrase when tokens other than filler words
   * remain around the matched date ("e148 מחר"). AI free text stays lenient.
   */
  strict?: boolean
}

export type DueDateParseResult = {
  /** `YYYY-MM-DD`. */
  date: string
  /** explicit 0.95, weekday 0.9, relative count 0.85, period end 0.8. */
  confidence: number
  rule: string
  matched: string
}

export const DUE_DATE_CONFIDENCE = {
  explicit: 0.95,
  weekday: 0.9,
  relativeDay: 0.9,
  relativeCount: 0.85,
  periodEnd: 0.8,
} as const

export const DEFAULT_DUE_DATE_TIME_ZONE = "Asia/Jerusalem"

// ---------------------------------------------------------------------------
// Civil-date arithmetic (days since the Unix epoch, no time zone involved).

const DAY_MS = 86_400_000

type Civil = { y: number; m: number; d: number }

function toDays(y: number, m: number, d: number): number {
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS)
}

function fromDays(days: number): Civil {
  const date = new Date(days * DAY_MS)

  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() }
}

function weekday(days: number): number {
  return new Date(days * DAY_MS).getUTCDay()
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

function isValidCivil(y: number, m: number, d: number): boolean {
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m)
}

function formatCivil({ y, m, d }: Civil): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
}

function addMonthsClamped(days: number, months: number): number {
  const { y, m, d } = fromDays(days)
  const index = y * 12 + (m - 1) + months
  const ny = Math.floor(index / 12)
  const nm = (index % 12) + 1

  return toDays(ny, nm, Math.min(d, daysInMonth(ny, nm)))
}

function endOfMonth(days: number, monthOffset = 0): number {
  const { y, m } = fromDays(days)
  const index = y * 12 + (m - 1) + monthOffset
  const ny = Math.floor(index / 12)
  const nm = (index % 12) + 1

  return toDays(ny, nm, daysInMonth(ny, nm))
}

function startOfNextMonth(days: number): number {
  return endOfMonth(days) + 1
}

function endOfQuarter(days: number): number {
  const { y, m } = fromDays(days)
  const quarterEndMonth = Math.ceil(m / 3) * 3

  return toDays(y, quarterEndMonth, daysInMonth(y, quarterEndMonth))
}

function endOfYear(days: number): number {
  return toDays(fromDays(days).y, 12, 31)
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** The anchor's calendar date in `timeZone`, or undefined when unparseable. */
export function anchorDays(anchor: string, timeZone: string): number | undefined {
  const plain = ISO_DATE.exec(anchor.trim())

  if (plain) {
    const [y, m, d] = plain.slice(1).map(Number)

    return isValidCivil(y, m, d) ? toDays(y, m, d) : undefined
  }

  const instant = new Date(anchor)

  if (Number.isNaN(instant.getTime())) return undefined

  let parts: Intl.DateTimeFormatPart[]

  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(instant)
  } catch {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(instant)
  }

  const part = (type: string) => Number(parts.find((entry) => entry.type === type)?.value)

  return toDays(part("year"), part("month"), part("day"))
}

/** Today's `YYYY-MM-DD` for an instant in `timeZone` (overdue checks). */
export function localDateIn(instant: Date | string, timeZone = DEFAULT_DUE_DATE_TIME_ZONE): string {
  const iso = typeof instant === "string" ? instant : instant.toISOString()
  const days = anchorDays(iso, timeZone)

  return days === undefined ? iso.slice(0, 10) : formatCivil(fromDays(days))
}

/** Whole days from `fromDate` to `toDate` (both `YYYY-MM-DD`). */
export function daysBetween(fromDate: string, toDate: string): number | undefined {
  const a = ISO_DATE.exec(fromDate)
  const b = ISO_DATE.exec(toDate)

  if (!a || !b) return undefined

  const [ay, am, ad] = a.slice(1).map(Number)
  const [by, bm, bd] = b.slice(1).map(Number)

  return toDays(by, bm, bd) - toDays(ay, am, ad)
}

/** Shifts a `YYYY-MM-DD` date by `days` (date chips in the editor). */
export function addDaysToDate(date: string, days: number): string | undefined {
  const match = ISO_DATE.exec(date)

  if (!match) return undefined

  const [y, m, d] = match.slice(1).map(Number)

  return formatCivil(fromDays(toDays(y, m, d) + days))
}

/** `due_date` (timestamptz) kept in sync with `due_on`: noon UTC of that day. */
export function dueDateFromDueOn(dueOn: string): string {
  return `${dueOn}T12:00:00.000Z`
}

/** `DD.MM.YYYY` (the Hebrew style-guide date format). */
export function formatDueDateDisplay(date: string): string {
  const match = ISO_DATE.exec(date)

  return match ? `${match[3]}.${match[2]}.${match[1]}` : date
}

// ---------------------------------------------------------------------------
// Normalization.

const NIQQUD = /[֑-ֽֿ-ׇ]/g
const MAQAF = /־/g
const HEBREW_LETTER = /[א-ת]/
/** One-letter Hebrew prefixes that attach to a date word (ו ש ב ל מ כ). */
const PREFIX_LETTERS = "ושבלמכ"

const HEBREW_WEEKDAYS: Record<string, number> = {
  ראשון: 0,
  שני: 1,
  שלישי: 2,
  רביעי: 3,
  חמישי: 4,
  שישי: 5,
  שבת: 6,
}

const HEBREW_WEEKDAY_LETTERS: Record<string, number> = {
  א: 0,
  ב: 1,
  ג: 2,
  ד: 3,
  ה: 4,
  ו: 5,
  ש: 6,
}

const HEBREW_MONTHS: Record<string, number> = {
  ינואר: 1,
  פברואר: 2,
  מרץ: 3,
  מרס: 3,
  אפריל: 4,
  מאי: 5,
  יוני: 6,
  יולי: 7,
  אוגוסט: 8,
  ספטמבר: 9,
  אוקטובר: 10,
  נובמבר: 11,
  דצמבר: 12,
}

/** Hebrew number words 1–10 (both genders) and 20/30. */
const HEBREW_UNITS: Record<string, number> = {
  אחד: 1,
  אחת: 1,
  שניים: 2,
  שתיים: 2,
  שני: 2,
  שתי: 2,
  שנים: 2,
  שתים: 2,
  שלושה: 3,
  שלוש: 3,
  ארבעה: 4,
  ארבע: 4,
  חמישה: 5,
  חמש: 5,
  שישה: 6,
  שש: 6,
  שבעה: 7,
  שבע: 7,
  שמונה: 8,
  תשעה: 9,
  תשע: 9,
  עשרה: 10,
  עשר: 10,
}

const HEBREW_TENS: Record<string, number> = { עשרים: 20, שלושים: 30 }

/** Words a prefix may be peeled from ("לסוף" → "סוף", "בשבוע" → "שבוע"). */
const HEBREW_VOCABULARY = new Set([
  "היום",
  "מחר",
  "מחרתיים",
  "יום",
  "ימים",
  "יומיים",
  "שבוע",
  "השבוע",
  "שבועות",
  "שבועיים",
  "חודש",
  "החודש",
  "חודשים",
  "חודשיים",
  "שנה",
  "השנה",
  "שנים",
  "שנתיים",
  "הבא",
  "הבאה",
  "הקרוב",
  "הקרובה",
  "סוף",
  "תחילת",
  "רבעון",
  "הרבעון",
  "תוך",
  "עוד",
  "עד",
  "לחודש",
  ...Object.keys(HEBREW_WEEKDAYS),
  ...Object.keys(HEBREW_MONTHS),
  ...Object.keys(HEBREW_UNITS),
  ...Object.keys(HEBREW_TENS),
])

function peelHebrewToken(token: string): string {
  if (!HEBREW_LETTER.test(token) || HEBREW_VOCABULARY.has(token)) return token

  let candidate = token

  for (let index = 0; index < 3 && candidate.length > 2; index += 1) {
    if (!PREFIX_LETTERS.includes(candidate[0])) break
    candidate = candidate.slice(1)
    if (HEBREW_VOCABULARY.has(candidate)) return candidate
    // "עדסוף" style run-ons are not Hebrew; only one-letter prefixes peel.
  }

  if (token.startsWith("עד") && HEBREW_VOCABULARY.has(token.slice(2))) {
    return token.slice(2)
  }

  return token
}

/**
 * Canonical form: NFKC, lowercase, no niqqud, unified quotes (׳ ’ → ',
 * ״ “ ” → "), maqaf → space, single spaces, and one-letter Hebrew prefixes
 * peeled from known date words.
 */
export function normalizeDuePhrase(text: string): string {
  const base = text
    .normalize("NFKC")
    .replace(MAQAF, " ")
    .replace(NIQQUD, "")
    .replace(/[׳‘’`´]/g, "'")
    .replace(/[״“”]/g, '"')
    .toLowerCase()
    .replace(/[,;!?()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim()

  return base
    .split(" ")
    .map((token) => {
      // Trailing sentence punctuation only (keep 15.11 / 15/11 intact).
      const trimmed = token.replace(/[.:]+$/, "")

      return peelHebrewToken(trimmed)
    })
    .filter(Boolean)
    .join(" ")
}

// ---------------------------------------------------------------------------
// Rules.

type RuleContext = {
  anchor: number
  weekStart: number
  workweekEnd: number
  dateOrder: "DMY" | "MDY"
  hebrew: boolean
}

type RuleHit = { days: number; confidence: number; rule: string; matched: string }

type Rule = (text: string, ctx: RuleContext) => RuleHit | null | undefined

/** Word boundary that understands Hebrew (JS `\b` is ASCII-only). */
const B = "(?<![\\p{L}\\p{N}])"
const E = "(?![\\p{L}\\p{N}])"

function re(source: string): RegExp {
  return new RegExp(`${B}(?:${source})${E}`, "u")
}

function startOfWeek(days: number, weekStart: number): number {
  return days - ((weekday(days) - weekStart + 7) % 7)
}

function weekdayOfWeek(weekStartDays: number, dow: number, weekStart: number): number {
  return weekStartDays + ((dow - weekStart + 7) % 7)
}

/** Next occurrence of `dow` strictly after the anchor. */
function nextWeekday(anchor: number, dow: number): number {
  const delta = (dow - weekday(anchor) + 7) % 7

  return anchor + (delta === 0 ? 7 : delta)
}

function thisWorkweekEnd(ctx: RuleContext): number {
  const end = weekdayOfWeek(startOfWeek(ctx.anchor, ctx.weekStart), ctx.workweekEnd, ctx.weekStart)

  // On Friday/Saturday this week's workweek is over: use next week's.
  return end < ctx.anchor ? end + 7 : end
}

function nextWorkweekEnd(ctx: RuleContext): number {
  return (
    weekdayOfWeek(startOfWeek(ctx.anchor, ctx.weekStart), ctx.workweekEnd, ctx.weekStart) + 7
  )
}

function dayOfNextWeek(ctx: RuleContext, dow: number): number {
  return weekdayOfWeek(startOfWeek(ctx.anchor, ctx.weekStart) + 7, dow, ctx.weekStart)
}

function expandYear(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const value = Number(raw)

  return raw.length <= 2 ? 2000 + value : value
}

/**
 * Explicit day/month: with a year it must be valid; without one, the next
 * valid occurrence on or after the anchor (past dates roll to next year,
 * 29 February rolls to the next leap year).
 */
function resolveDayMonth(
  ctx: RuleContext,
  day: number,
  month: number,
  year: number | undefined
): number | undefined {
  if (year !== undefined) {
    return isValidCivil(year, month, day) ? toDays(year, month, day) : undefined
  }

  const anchorYear = fromDays(ctx.anchor).y

  for (let candidate = anchorYear; candidate <= anchorYear + 8; candidate += 1) {
    if (!isValidCivil(candidate, month, day)) continue

    const days = toDays(candidate, month, day)

    if (days >= ctx.anchor) return days
  }

  return undefined
}

/** "ה-15" / "the 15th": this month, or next month when already past. */
function resolveDayOfMonth(ctx: RuleContext, day: number): number | undefined {
  if (day < 1 || day > 31) return undefined

  const { y, m } = fromDays(ctx.anchor)

  for (let offset = 0; offset < 3; offset += 1) {
    const index = y * 12 + (m - 1) + offset
    const ny = Math.floor(index / 12)
    const nm = (index % 12) + 1

    if (!isValidCivil(ny, nm, day)) continue

    const days = toDays(ny, nm, day)

    if (days >= ctx.anchor) return days
  }

  return undefined
}

const NUMERIC_PREFIX = `(?:[${PREFIX_LETTERS}ה]{1,3}-?)?`

const isoDateRule: Rule = (text) => {
  const match = new RegExp(`${B}${NUMERIC_PREFIX}(\\d{4})-(\\d{1,2})-(\\d{1,2})${E}`, "u").exec(text)

  if (!match) return null

  const [y, m, d] = match.slice(1, 4).map(Number)

  if (!isValidCivil(y, m, d)) return null

  return {
    days: toDays(y, m, d),
    confidence: DUE_DATE_CONFIDENCE.explicit,
    rule: "explicit_iso",
    matched: match[0],
  }
}

const numericDateRule: Rule = (text, ctx) => {
  const match = new RegExp(
    `${B}${NUMERIC_PREFIX}(\\d{1,2})([./])(\\d{1,2})(?:\\2(\\d{4}|\\d{2}))?(?![\\p{L}\\p{N}]|[./]\\d)`,
    "u"
  ).exec(text)

  if (!match) return null

  const first = Number(match[1])
  const second = Number(match[3])
  const order = ctx.hebrew ? "DMY" : ctx.dateOrder
  const [day, month] = order === "DMY" ? [first, second] : [second, first]
  const days = resolveDayMonth(ctx, day, month, expandYear(match[4]))

  if (days === undefined) return null

  return {
    days,
    confidence: DUE_DATE_CONFIDENCE.explicit,
    rule: "explicit_numeric",
    matched: match[0],
  }
}

const HEBREW_MONTH_ALT = Object.keys(HEBREW_MONTHS).join("|")

const hebrewMonthNameRule: Rule = (text, ctx) => {
  const match = new RegExp(
    `${B}${NUMERIC_PREFIX}(\\d{1,2}) (?:[בל]-?)?(${HEBREW_MONTH_ALT})(?: (\\d{4}))?${E}`,
    "u"
  ).exec(text)

  if (!match) return null

  const days = resolveDayMonth(
    ctx,
    Number(match[1]),
    HEBREW_MONTHS[match[2]],
    match[3] ? Number(match[3]) : undefined
  )

  if (days === undefined) return null

  return { days, confidence: DUE_DATE_CONFIDENCE.explicit, rule: "explicit_month_name", matched: match[0] }
}

const hebrewDayOfMonthRule: Rule = (text, ctx) => {
  const match = new RegExp(`${B}[${PREFIX_LETTERS}]{0,2}ה-?(\\d{1,2})(?![\\p{L}\\p{N}]|[./:]\\d)`, "u").exec(
    text
  )

  if (!match) return null

  const days = resolveDayOfMonth(ctx, Number(match[1]))

  if (days === undefined) return null

  return { days, confidence: DUE_DATE_CONFIDENCE.explicit, rule: "day_of_month", matched: match[0] }
}

function hebrewNumber(words: string): number | undefined {
  const tokens = words.trim().split(" ").filter(Boolean)

  if (tokens.length === 1) {
    if (/^\d{1,3}$/.test(tokens[0])) return Number(tokens[0])

    return HEBREW_UNITS[tokens[0]] ?? HEBREW_TENS[tokens[0]]
  }

  if (tokens.length === 2) {
    // 11–19: "אחד עשר", "שלושה עשר", "שתים עשרה".
    if ((tokens[1] === "עשר" || tokens[1] === "עשרה") && HEBREW_UNITS[tokens[0]] < 10) {
      return 10 + HEBREW_UNITS[tokens[0]]
    }
    // 21–29: "עשרים ואחד" (the ו is peeled).
    if (HEBREW_TENS[tokens[0]] && HEBREW_UNITS[tokens[1]] && HEBREW_UNITS[tokens[1]] < 10) {
      return HEBREW_TENS[tokens[0]] + HEBREW_UNITS[tokens[1]]
    }
  }

  return undefined
}

const HEBREW_NUMBER_WORD_ALT = [
  "\\d{1,3}",
  ...Object.keys(HEBREW_TENS),
  ...Object.keys(HEBREW_UNITS),
]
  .sort((a, b) => b.length - a.length)
  .join("|")

const HEBREW_NUMBER_PHRASE = `(?:(?:${HEBREW_NUMBER_WORD_ALT})(?: (?:עשר|עשרה|${Object.keys(HEBREW_UNITS).join("|")}))?)`

function applyCount(anchor: number, count: number, unit: "day" | "week" | "month" | "year") {
  if (unit === "day") return anchor + count
  if (unit === "week") return anchor + count * 7
  if (unit === "month") return addMonthsClamped(anchor, count)

  return addMonthsClamped(anchor, count * 12)
}

const HEBREW_DUAL_UNITS: Record<string, [number, "day" | "week" | "month" | "year"]> = {
  יומיים: [2, "day"],
  שבועיים: [2, "week"],
  חודשיים: [2, "month"],
  שנתיים: [2, "year"],
  יום: [1, "day"],
  שבוע: [1, "week"],
  חודש: [1, "month"],
  שנה: [1, "year"],
}

function hebrewUnit(word: string): "day" | "week" | "month" | "year" | undefined {
  if (word === "יום" || word === "ימים") return "day"
  if (word === "שבוע" || word === "שבועות") return "week"
  if (word === "חודש" || word === "חודשים") return "month"
  if (word === "שנה" || word === "שנים") return "year"

  return undefined
}

const hebrewRelativeCountRule: Rule = (text, ctx) => {
  const lead = "(?:תוך|עוד|בתוך|בעוד|לעוד)"
  const counted = new RegExp(
    `${B}${lead} (${HEBREW_NUMBER_PHRASE}) (ימים|יום|שבועות|שבוע|חודשים|חודש|שנים|שנה)${E}`,
    "u"
  ).exec(text)

  if (counted) {
    const count = hebrewNumber(counted[1])
    const unit = hebrewUnit(counted[2])

    if (count !== undefined && unit && count > 0 && count <= 366) {
      return {
        days: applyCount(ctx.anchor, count, unit),
        confidence: DUE_DATE_CONFIDENCE.relativeCount,
        rule: "relative_count",
        matched: counted[0],
      }
    }
  }

  const dual = new RegExp(
    `${B}${lead} (${Object.keys(HEBREW_DUAL_UNITS).join("|")})${E}`,
    "u"
  ).exec(text)

  if (dual) {
    const [count, unit] = HEBREW_DUAL_UNITS[dual[1]]

    return {
      days: applyCount(ctx.anchor, count, unit),
      confidence: DUE_DATE_CONFIDENCE.relativeCount,
      rule: "relative_count",
      matched: dual[0],
    }
  }

  return null
}

const HEBREW_WEEKDAY_ALT = Object.keys(HEBREW_WEEKDAYS).join("|")
/** "יום א'" … "יום ו'", "יום ש'" (gershayim already unified to '). */
const HEBREW_WEEKDAY_LETTER = `יום ([אבגדהוש])'`
const NEXT_WORD = "(?:הבא|הבאה|הקרוב|הקרובה)"

function hebrewWeekdayFrom(match: RegExpExecArray, nameGroup: number, letterGroup: number) {
  if (match[nameGroup]) return HEBREW_WEEKDAYS[match[nameGroup]]
  if (match[letterGroup]) return HEBREW_WEEKDAY_LETTERS[match[letterGroup]]

  return undefined
}

const hebrewNextWeekWeekdayRule: Rule = (text, ctx) => {
  const day = `(?:יום (${HEBREW_WEEKDAY_ALT})|${HEBREW_WEEKDAY_LETTER}|(${HEBREW_WEEKDAY_ALT}))`
  const patterns = [
    // "בשבוע הבא ביום שלישי"
    new RegExp(`${B}שבוע ${NEXT_WORD} (?:עד )?${day}${E}`, "u"),
    // "ביום שלישי בשבוע הבא"
    new RegExp(`${B}${day} (?:של )?שבוע ${NEXT_WORD}${E}`, "u"),
  ]

  for (const pattern of patterns) {
    const match = pattern.exec(text)

    if (!match) continue

    const dow = match[1]
      ? HEBREW_WEEKDAYS[match[1]]
      : match[2]
        ? HEBREW_WEEKDAY_LETTERS[match[2]]
        : HEBREW_WEEKDAYS[match[3]]

    if (dow === undefined) continue

    return {
      days: dayOfNextWeek(ctx, dow),
      confidence: DUE_DATE_CONFIDENCE.weekday,
      rule: "weekday_next_week",
      matched: match[0],
    }
  }

  return null
}

const hebrewWeekdayRule: Rule = (text, ctx) => {
  const withDay = new RegExp(
    `${B}(?:יום (${HEBREW_WEEKDAY_ALT})|${HEBREW_WEEKDAY_LETTER})(?: ${NEXT_WORD})?${E}`,
    "u"
  ).exec(text)
  // Bare names: "ראשון"/"שני" also mean first/second, so they need "עד".
  const bare =
    withDay ??
    new RegExp(
      `${B}(?:עד )?(שלישי|רביעי|חמישי|שישי|שבת)(?: ${NEXT_WORD})?${E}|${B}עד (ראשון|שני)(?: ${NEXT_WORD})?${E}`,
      "u"
    ).exec(text)

  if (!bare) return null

  const dow = withDay
    ? hebrewWeekdayFrom(withDay, 1, 2)
    : HEBREW_WEEKDAYS[bare[1] ?? bare[2]]

  if (dow === undefined) return null

  return {
    days: nextWeekday(ctx.anchor, dow),
    confidence: DUE_DATE_CONFIDENCE.weekday,
    rule: "weekday",
    matched: bare[0],
  }
}

const hebrewPeriodRules: Rule = (text, ctx) => {
  const table: Array<[RegExp, () => number, string]> = [
    [re(`סוף (?:ה)?שבוע ${NEXT_WORD}`), () => nextWorkweekEnd(ctx), "next_week"],
    [re(`(?:ה)?שבוע ${NEXT_WORD}`), () => nextWorkweekEnd(ctx), "next_week"],
    [re(`סוף (?:ה)?שבוע|השבוע`), () => thisWorkweekEnd(ctx), "end_of_week"],
    [re(`תחילת (?:ה)?חודש ${NEXT_WORD}`), () => startOfNextMonth(ctx.anchor), "start_of_next_month"],
    [re(`סוף (?:ה)?חודש ${NEXT_WORD}`), () => endOfMonth(ctx.anchor, 1), "end_of_next_month"],
    [re(`(?:ה)?חודש ${NEXT_WORD}`), () => endOfMonth(ctx.anchor, 1), "next_month"],
    [re(`סוף (?:ה)?חודש|החודש`), () => endOfMonth(ctx.anchor), "end_of_month"],
    [re(`סוף (?:ה)?רבעון`), () => endOfQuarter(ctx.anchor), "end_of_quarter"],
    [re(`סוף (?:ה)?שנה|השנה`), () => endOfYear(ctx.anchor), "end_of_year"],
  ]

  for (const [pattern, resolve, rule] of table) {
    const match = pattern.exec(text)

    if (match) {
      return { days: resolve(), confidence: DUE_DATE_CONFIDENCE.periodEnd, rule, matched: match[0] }
    }
  }

  return null
}

const hebrewRelativeDayRule: Rule = (text, ctx) => {
  const match = re("מחרתיים|מחר|היום").exec(text)

  if (!match) return null

  const offset = match[0] === "מחרתיים" ? 2 : match[0] === "מחר" ? 1 : 0

  return {
    days: ctx.anchor + offset,
    confidence: DUE_DATE_CONFIDENCE.relativeDay,
    rule: offset === 0 ? "today" : offset === 1 ? "tomorrow" : "day_after_tomorrow",
    matched: match[0],
  }
}

// English ---------------------------------------------------------------------

const ENGLISH_WEEKDAYS: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tues: 2,
  tue: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thurs: 4,
  thur: 4,
  thu: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
}

const ENGLISH_MONTHS: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
}

const ENGLISH_NUMBERS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  "a couple of": 2,
  "a couple": 2,
  couple: 2,
}

function alternation(words: string[]): string {
  return [...words].sort((a, b) => b.length - a.length).join("|")
}

const EN_WEEKDAY_ALT = alternation(Object.keys(ENGLISH_WEEKDAYS))
const EN_MONTH_ALT = alternation(Object.keys(ENGLISH_MONTHS))
const EN_NUMBER_ALT = `\\d{1,3}|twenty[ -](?:one|two|three|four|five|six|seven|eight|nine)|${alternation(Object.keys(ENGLISH_NUMBERS))}`

function englishNumber(raw: string): number | undefined {
  if (/^\d+$/.test(raw)) return Number(raw)

  const compound = /^twenty[ -](\w+)$/.exec(raw)

  if (compound) {
    const unit = ENGLISH_NUMBERS[compound[1]]

    return unit && unit < 10 ? 20 + unit : undefined
  }

  return ENGLISH_NUMBERS[raw]
}

function englishUnit(raw: string): "day" | "week" | "month" | "year" | undefined {
  if (raw.startsWith("day")) return "day"
  if (raw.startsWith("week")) return "week"
  if (raw.startsWith("month")) return "month"
  if (raw.startsWith("year")) return "year"

  return undefined
}

const englishMonthNameRule: Rule = (text, ctx) => {
  const ordinal = "(\\d{1,2})(?:st|nd|rd|th)?"
  const year = "(?:,? (\\d{4}))?"
  const monthFirst = new RegExp(`${B}(${EN_MONTH_ALT})\\.? ${ordinal}${year}${E}`, "u").exec(text)
  const dayFirst = new RegExp(`${B}${ordinal} (?:of )?(${EN_MONTH_ALT})\\.?${year}${E}`, "u").exec(text)
  const hit = monthFirst
    ? { day: Number(monthFirst[2]), month: ENGLISH_MONTHS[monthFirst[1]], year: monthFirst[3], matched: monthFirst[0] }
    : dayFirst
      ? { day: Number(dayFirst[1]), month: ENGLISH_MONTHS[dayFirst[2]], year: dayFirst[3], matched: dayFirst[0] }
      : undefined

  if (!hit) return null

  const days = resolveDayMonth(ctx, hit.day, hit.month, hit.year ? Number(hit.year) : undefined)

  if (days === undefined) return null

  return { days, confidence: DUE_DATE_CONFIDENCE.explicit, rule: "explicit_month_name", matched: hit.matched }
}

const englishDayOfMonthRule: Rule = (text, ctx) => {
  const match = re("(?:the )(\\d{1,2})(?:st|nd|rd|th)(?: of (?:the|this) month)?").exec(text)

  if (!match) return null

  const days = resolveDayOfMonth(ctx, Number(match[1]))

  if (days === undefined) return null

  return { days, confidence: DUE_DATE_CONFIDENCE.explicit, rule: "day_of_month", matched: match[0] }
}

const englishRelativeCountRule: Rule = (text, ctx) => {
  const match = re(
    `(?:in|within|in the next|over the next) (${EN_NUMBER_ALT}) (days?|weeks?|months?|years?)`
  ).exec(text)

  if (!match) return null

  const count = englishNumber(match[1])
  const unit = englishUnit(match[2])

  if (count === undefined || !unit || count <= 0 || count > 366) return null

  return {
    days: applyCount(ctx.anchor, count, unit),
    confidence: DUE_DATE_CONFIDENCE.relativeCount,
    rule: "relative_count",
    matched: match[0],
  }
}

const englishNextWeekWeekdayRule: Rule = (text, ctx) => {
  const patterns = [
    re(`(?:on )?(${EN_WEEKDAY_ALT}) (?:of )?next week`),
    re(`next week (?:on )?(${EN_WEEKDAY_ALT})`),
  ]

  for (const pattern of patterns) {
    const match = pattern.exec(text)

    if (!match) continue

    return {
      days: dayOfNextWeek(ctx, ENGLISH_WEEKDAYS[match[1]]),
      confidence: DUE_DATE_CONFIDENCE.weekday,
      rule: "weekday_next_week",
      matched: match[0],
    }
  }

  return null
}

const englishWeekdayRule: Rule = (text, ctx) => {
  // "next Monday" is treated like "Monday" (the Hebrew "הבא" rule).
  const match = re(`(?:(?:by|on|this|next|until|till|before) )?(${EN_WEEKDAY_ALT})`).exec(text)

  if (!match) return null

  // "sat"/"sun"/"wed" style abbreviations collide with words: only accept
  // the short forms when they are the whole phrase or follow a preposition.
  const word = match[1]
  const isShort = !word.endsWith("day")

  if (isShort && match[0] === word && text.trim() !== word) return null

  return {
    days: nextWeekday(ctx.anchor, ENGLISH_WEEKDAYS[word]),
    confidence: DUE_DATE_CONFIDENCE.weekday,
    rule: "weekday",
    matched: match[0],
  }
}

const englishPeriodRules: Rule = (text, ctx) => {
  const table: Array<[RegExp, () => number, string]> = [
    [re("end of (?:the )?next week"), () => nextWorkweekEnd(ctx), "next_week"],
    [re("next week"), () => nextWorkweekEnd(ctx), "next_week"],
    [re("(?:the )?end of (?:the |this )?week|eow|this week"), () => thisWorkweekEnd(ctx), "end_of_week"],
    [
      re("(?:the )?(?:beginning|start) of (?:the )?next month|early next month"),
      () => startOfNextMonth(ctx.anchor),
      "start_of_next_month",
    ],
    [re("(?:the )?end of (?:the )?next month"), () => endOfMonth(ctx.anchor, 1), "end_of_next_month"],
    [re("next month"), () => endOfMonth(ctx.anchor, 1), "next_month"],
    [re("(?:the )?end of (?:the |this )?month|eom|this month"), () => endOfMonth(ctx.anchor), "end_of_month"],
    [re("(?:the )?end of (?:the |this )?quarter|eoq"), () => endOfQuarter(ctx.anchor), "end_of_quarter"],
    [re("(?:the )?end of (?:the |this )?year|eoy"), () => endOfYear(ctx.anchor), "end_of_year"],
  ]

  for (const [pattern, resolve, rule] of table) {
    const match = pattern.exec(text)

    if (match) {
      return { days: resolve(), confidence: DUE_DATE_CONFIDENCE.periodEnd, rule, matched: match[0] }
    }
  }

  return null
}

const englishRelativeDayRule: Rule = (text, ctx) => {
  const match = re(
    "(?:the )?day after tomorrow|tomorrow|tmrw|tmr|today|tonight|(?:by )?(?:the )?end of (?:the )?day|eod"
  ).exec(text)

  if (!match) return null

  const phrase = match[0]
  const offset = phrase.includes("after tomorrow") ? 2 : /tomorrow|tmrw|tmr/.test(phrase) ? 1 : 0

  return {
    days: ctx.anchor + offset,
    confidence: DUE_DATE_CONFIDENCE.relativeDay,
    rule: offset === 0 ? "today" : offset === 1 ? "tomorrow" : "day_after_tomorrow",
    matched: phrase,
  }
}

/**
 * Most specific first: explicit dates, counts and "weekday of next week"
 * before bare weekdays and period ends.
 */
const RULES: Rule[] = [
  isoDateRule,
  numericDateRule,
  hebrewMonthNameRule,
  englishMonthNameRule,
  hebrewDayOfMonthRule,
  englishDayOfMonthRule,
  hebrewRelativeCountRule,
  englishRelativeCountRule,
  hebrewNextWeekWeekdayRule,
  englishNextWeekWeekdayRule,
  hebrewWeekdayRule,
  englishWeekdayRule,
  hebrewPeriodRules,
  englishPeriodRules,
  hebrewRelativeDayRule,
  englishRelativeDayRule,
]

export function parseDueDate(text: string, opts: DueDateParseOptions): DueDateParseResult | null {
  if (typeof text !== "string" || !text.trim() || text.length > 500) return null

  const anchor = anchorDays(opts.anchor, opts.timeZone ?? DEFAULT_DUE_DATE_TIME_ZONE)

  if (anchor === undefined) return null

  const normalized = normalizeDuePhrase(text)
  const ctx: RuleContext = {
    anchor,
    weekStart: clampWeekday(opts.weekStart, 0),
    workweekEnd: clampWeekday(opts.workweekEnd, 4),
    dateOrder: opts.dateOrder ?? "DMY",
    hebrew: HEBREW_LETTER.test(normalized),
  }

  for (const rule of RULES) {
    const hit = rule(normalized, ctx)

    if (hit) {
      if (opts.strict && hasLeftoverTokens(normalized, hit.matched)) return null
      return {
        date: formatCivil(fromDays(hit.days)),
        confidence: hit.confidence,
        rule: hit.rule,
        matched: hit.matched.trim(),
      }
    }
  }

  return null
}

/** Words that may surround a due date in user input without changing it. */
const DUE_FILLER_WORDS = new Set([
  "by", "until", "till", "til", "due", "on", "at", "the", "before", "no", "later", "than", "in", "of",
  "עד", "ב", "ל", "של", "את", "ה", "לא", "יאוחר", "מ", "עוד", "יום",
])

function hasLeftoverTokens(normalized: string, matched: string): boolean {
  const index = matched ? normalized.indexOf(matched) : -1
  const rest = index >= 0 ? normalized.slice(0, index) + " " + normalized.slice(index + matched.length) : normalized

  return rest
    .split(/\s+/)
    .map((token) => token.replace(/^["'.-]+|["'.-]+$/g, ""))
    .filter(Boolean)
    .some((token) => !DUE_FILLER_WORDS.has(token))
}

function clampWeekday(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! >= 0 && value! <= 6 ? value! : fallback
}
