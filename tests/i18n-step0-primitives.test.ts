/**
 * M9 Step 0 smoke tests for the minimal `format.ts`, `hebrew-text.ts` and
 * time-zone resolver. Package A adds the full suites (format-he,
 * hebrew-text, hebrew-bidi-visual, hebrew-list).
 */
import { describe, expect, it } from "vitest"

import {
  formatCount,
  formatDate,
  formatDuration,
  formatNumber,
  formatPercent,
  formatRelative,
  formatTimecode,
} from "@/lib/i18n/format"
import {
  LRI,
  NBSP,
  PDI,
  RLM,
  WJ,
  directionFor,
  firstStrongDirection,
  fixHebrewTypography,
  hasHebrew,
  hebrewList,
  isRtlLanguage,
  isolateLtr,
  rtlLine,
  stripBidiControls,
} from "@/lib/i18n/hebrew-text"
import { isValidTimeZone, resolveTimeZone } from "@/lib/i18n/time-zone"

const he = { locale: "he" as const, timeZone: "Asia/Jerusalem" }
const en = { locale: "en" as const, timeZone: "Asia/Jerusalem" }

describe("format.ts (minimal)", () => {
  it("formats in the explicit zone with Western digits and a 24h Hebrew clock", () => {
    const value = "2026-10-13T12:30:00Z"

    expect(formatDate(value, he, "time")).toBe("15:30")
    expect(formatDate(value, { ...he, timeZone: "UTC" }, "time")).toBe("12:30")
    expect(formatDate(value, he, "date")).toMatch(/13/)
    expect(formatDate(value, he, "date")).not.toMatch(/[٠-٩]/)
    expect(formatDate("not a date", he)).toBe("")
  })

  it("formats durations with Hebrew dual forms", () => {
    expect(formatDuration(60_000, he)).toBe("דקה")
    expect(formatDuration(120_000, he)).toBe("שתי דקות")
    expect(formatDuration(2 * 3600_000, he)).toBe("שעתיים")
    expect(formatDuration(80 * 60_000, he)).toBe("שעה ו־20 דקות")
    expect(formatDuration(80 * 60_000, en)).toBe("1 hr 20 min")
    expect(formatDuration(3_723_000, en, "clock")).toBe("1:02:03")
  })

  it("formats numbers, percents, counts, timecodes and relative times", () => {
    expect(formatNumber(1234.5, en)).toBe("1,234.5")
    expect(formatPercent(0.42, he)).toMatch(/42/)
    expect(formatCount(2, he, { one: "פגישה", two: "שתי פגישות", other: "{count} פגישות" })).toBe("שתי פגישות")
    expect(formatCount(7, en, { one: "{count} meeting", other: "{count} meetings" })).toBe("7 meetings")
    expect(formatTimecode(754_000)).toBe("12:34")
    expect(formatRelative(new Date("2026-10-13T12:00:00Z"), new Date("2026-10-13T12:00:10Z"), en)).toBe("now")
    expect(formatRelative(new Date("2026-10-13T11:55:00Z"), new Date("2026-10-13T12:00:00Z"), en)).toBe("5 minutes ago")
  })
})

describe("hebrew-text.ts (minimal)", () => {
  it("detects Hebrew and direction", () => {
    expect(hasHebrew("שלום")).toBe(true)
    expect(firstStrongDirection("12 שלום")).toBe("rtl")
    expect(firstStrongDirection("  12 ")).toBe("neutral")
    expect(isRtlLanguage("he-IL")).toBe(true)
    expect(isRtlLanguage("iw")).toBe(true)
    expect(isRtlLanguage("en")).toBe(false)
    expect(directionFor("en", "שלום")).toBe("ltr")
    expect(directionFor("mixed", "שלום")).toBe("rtl")
    expect(directionFor(null, "hello")).toBe("ltr")
  })

  it("typesets RLM, WJ and NBSP idempotently and leaves English alone", () => {
    const fixed = fixHebrewTypography("פגישה עם Lisboa 12 משתתפים ל-Google — היום")

    expect(fixed).toContain(`Lisboa${RLM} 12`)
    expect(fixed).toContain(`ל-${WJ}Google`)
    expect(fixed).toContain(`${NBSP}— `)
    expect(fixHebrewTypography(fixed)).toBe(fixed)
    expect(fixHebrewTypography("Meeting with Lisboa 12 people — today")).toBe("Meeting with Lisboa 12 people — today")
    expect(fixHebrewTypography("ראו https://example.com/a-b 12")).toBe("ראו https://example.com/a-b 12")
  })

  it("isolates, prefixes and strips bidi controls", () => {
    expect(isolateLtr("Slack")).toBe(`${LRI}Slack${PDI}`)
    expect(isolateLtr(isolateLtr("Slack"))).toBe(`${LRI}Slack${PDI}`)
    expect(rtlLine("Google היום")).toBe(`${RLM}Google היום`)
    expect(rtlLine("היום Google")).toBe("היום Google")
    expect(stripBidiControls(`${RLM}a${WJ}b${LRI}c${PDI}`)).toBe("abc")
  })

  it("joins Hebrew lists with ו- before a Latin last item", () => {
    expect(hebrewList(["Slack", "Notion", "HubSpot"], "he")).toBe(`Slack, Notion ו-${WJ}HubSpot`)
    expect(hebrewList(["א", "ב", "ג"], "he")).toBe("א, ב וג")
    expect(hebrewList(["a", "b", "c"], "en")).toBe("a, b, and c")
  })
})

describe("time-zone resolver", () => {
  it("prefers user → workspace → env → Asia/Jerusalem, validating each", () => {
    expect(isValidTimeZone("Europe/Lisbon")).toBe(true)
    expect(isValidTimeZone("UTC")).toBe(true)
    expect(isValidTimeZone("Mars/Base")).toBe(false)
    expect(resolveTimeZone({ user: "Europe/Lisbon", workspace: "UTC" })).toBe("Europe/Lisbon")
    expect(resolveTimeZone({ user: "nope", workspace: "UTC" })).toBe("UTC")
    expect(resolveTimeZone({ env: " America/New_York " })).toBe("America/New_York")
    expect(resolveTimeZone()).toBe("Asia/Jerusalem")
  })
})
