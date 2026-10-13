/**
 * M9 A2 (docs/parity/m9.md "Formatting API"): Hebrew and English formatting
 * with an explicit zone, dual forms, natural relative phrasing, Western
 * digits, process-TZ independence and Asia/Jerusalem DST edges.
 */
import { afterEach, describe, expect, it } from "vitest"

import {
  formatCount,
  formatDate,
  formatDuration,
  formatNumber,
  formatPercent,
  formatRelative,
  formatTimecode,
  type Fmt,
} from "@/lib/i18n/format"

const he: Fmt = { locale: "he", timeZone: "Asia/Jerusalem" }
const en: Fmt = { locale: "en", timeZone: "Asia/Jerusalem" }
const EASTERN_ARABIC = /[٠-٩۰-۹]/

describe("formatDuration", () => {
  it("uses Hebrew dual forms and the ו־ conjunction", () => {
    expect(formatDuration(60_000, he)).toBe("דקה")
    expect(formatDuration(120_000, he)).toBe("שתי דקות")
    expect(formatDuration(5 * 60_000, he)).toBe("5 דקות")
    expect(formatDuration(3_600_000, he)).toBe("שעה")
    expect(formatDuration(7_200_000, he)).toBe("שעתיים")
    expect(formatDuration(3 * 3_600_000, he)).toBe("3 שעות")
    expect(formatDuration(80 * 60_000, he)).toBe("שעה ו־20 דקות")
    expect(formatDuration(122 * 60_000, he)).toBe("שעתיים ו־שתי דקות")
    expect(formatDuration(2_000, he)).toBe("שתי שניות")
  })

  it("formats English long, short and clock styles", () => {
    expect(formatDuration(80 * 60_000, en)).toBe("1 hr 20 min")
    expect(formatDuration(80 * 60_000, en, "short")).toBe("1h 20m")
    expect(formatDuration(3_723_000, en, "clock")).toBe("1:02:03")
    expect(formatDuration(-5, en)).toBe("0 sec")
  })
})

describe("formatRelative", () => {
  const now = new Date("2026-10-13T12:00:00Z") // Tuesday 15:00 in Jerusalem

  it("phrases recent times naturally in Hebrew", () => {
    expect(formatRelative(new Date("2026-10-13T11:59:50Z"), now, he)).toBe("עכשיו")
    expect(formatRelative(new Date("2026-10-13T11:59:00Z"), now, he)).toBe("לפני דקה")
    expect(formatRelative(new Date("2026-10-13T11:58:00Z"), now, he)).toBe("לפני שתי דקות")
    expect(formatRelative(new Date("2026-10-13T11:55:00Z"), now, he)).toBe("לפני 5 דקות")
    expect(formatRelative(new Date("2026-10-13T10:00:00Z"), now, he)).toBe("לפני שעתיים")
    expect(formatRelative(new Date("2026-10-13T12:05:00Z"), now, he)).toBe("בעוד 5 דקות")
  })

  it("uses yesterday and weekday phrasing within a week, then the date", () => {
    expect(formatRelative(new Date("2026-10-12T11:30:00Z"), now, he)).toBe("אתמול ב־14:30")
    expect(formatRelative(new Date("2026-10-10T06:00:00Z"), now, he)).toBe("יום שבת ב־09:00")
    expect(formatRelative(new Date("2026-10-01T06:00:00Z"), now, he)).toBe("1 באוק׳ 2026")
    expect(formatRelative(new Date("2026-10-12T11:30:00Z"), now, en)).toMatch(/^Yesterday at 2:30\sPM$/)
    expect(formatRelative(new Date("2026-10-13T10:00:00Z"), now, en)).toBe("2 hours ago")
  })

  it("counts calendar days in the formatting zone across the DST change", () => {
    // 2026-10-25 02:00 IDT → 01:00 IST in Asia/Jerusalem.
    const lateNight = new Date("2026-10-24T19:30:00Z") // Sat 22:30 IDT
    const nextEvening = new Date("2026-10-25T19:00:00Z") // Sun 21:00 IST (23.5 h later)

    expect(formatRelative(lateNight, nextEvening, he)).toBe("אתמול ב־22:30")
  })

  it("returns an empty string for invalid input", () => {
    expect(formatRelative("not a date", now, he)).toBe("")
    expect(formatDate("not a date", he)).toBe("")
  })
})

describe("formatDate", () => {
  it("abbreviates Hebrew months and uses a 24-hour clock with Western digits", () => {
    const value = new Date("2026-10-13T13:05:00Z")

    expect(formatDate(value, he, "date")).toBe("13 באוק׳ 2026")
    expect(formatDate(value, he, "time")).toBe("16:05")
    expect(formatDate(value, he, "dateTime")).not.toMatch(EASTERN_ARABIC)
    expect(formatDate(value, he, "weekdayDate")).toContain("יום שלישי")
    expect(formatDate(value, en, "date")).toBe("Oct 13, 2026")
  })

  it("writes English date + time with commas and plain spaces (PDF header)", () => {
    const value = new Date("2026-10-12T12:13:00Z")

    expect(formatDate(value, en, "dateTime")).toBe("Oct 12, 2026, 3:13 PM")
    expect(formatDate(value, en, "dateTimeLong")).toBe("October 12, 2026, 3:13 PM")
    expect(formatDate(new Date("2026-10-12T21:05:00Z"), en, "dateTime")).toBe("Oct 13, 2026, 12:05 AM")
  })

  it("renders both sides of the Jerusalem DST change correctly", () => {
    expect(formatDate(new Date("2026-10-24T22:30:00Z"), he, "time")).toBe("01:30")
    expect(formatDate(new Date("2026-10-24T23:30:00Z"), he, "time")).toBe("01:30")
    expect(formatDate(new Date("2026-03-27T00:30:00Z"), he, "time")).toBe("03:30")
  })

  describe("is independent of the process time zone", () => {
    const original = process.env.TZ

    afterEach(() => {
      process.env.TZ = original
    })

    it("gives identical output under America/New_York and Asia/Jerusalem", () => {
      const value = new Date("2026-10-13T22:30:00Z")
      const sample = () => [
        formatDate(value, he, "dateTime"),
        formatDate(value, en, "weekdayDate"),
        formatRelative(value, new Date("2026-10-14T08:00:00Z"), he),
      ]

      process.env.TZ = "America/New_York"
      const newYork = sample()
      process.env.TZ = "Asia/Jerusalem"
      const jerusalem = sample()

      expect(newYork).toEqual(jerusalem)
    })
  })
})

describe("numbers", () => {
  it("formats numbers, percents, counts and timecodes with Western digits", () => {
    expect(formatNumber(1234.5, he)).toBe("1,234.5")
    expect(formatPercent(0.42, he)).not.toMatch(EASTERN_ARABIC)
    expect(formatCount(1, he, { one: "פגישה אחת", two: "שתי פגישות", other: "{count} פגישות" })).toBe("פגישה אחת")
    expect(formatCount(2, he, { one: "פגישה אחת", two: "שתי פגישות", other: "{count} פגישות" })).toBe("שתי פגישות")
    expect(formatCount(1200, he, { one: "פגישה אחת", other: "{count} פגישות" })).toBe("1,200 פגישות")
    expect(formatTimecode(3_723_000)).toBe("1:02:03")
    expect(formatTimecode(-1)).toBe("0:00")
  })
})
