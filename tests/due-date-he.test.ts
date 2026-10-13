import { describe, expect, it } from "vitest"

import {
  addDaysToDate,
  daysBetween,
  formatDueDateDisplay,
  localDateIn,
  normalizeDuePhrase,
  parseDueDate,
} from "@/lib/tasks/due-date"

/**
 * Hebrew due-date matrix (docs/parity/m5.md B1). Anchors are calendar dates
 * in Asia/Jerusalem. October 2026: Thu 15, Fri 16, Sat 17, Sun 18 … Sat 31.
 */
const THU = "2026-10-15T09:00:00+03:00"
const FRI = "2026-10-16T09:00:00+03:00"
const SAT = "2026-10-17T09:00:00+03:00"
const SUN = "2026-10-18T09:00:00+03:00"
const MONTH_END_SAT = "2026-10-31T10:00:00+02:00"
const YEAR_END_MON = "2026-12-28T10:00:00+02:00"

type Case = [phrase: string, anchor: string, expected: string | null, rule?: string]

const cases: Case[] = [
  // Relative days
  ["היום", THU, "2026-10-15", "today"],
  ["מחר", THU, "2026-10-16", "tomorrow"],
  ["מחרתיים", THU, "2026-10-17", "day_after_tomorrow"],
  ["עד מחר", THU, "2026-10-16"],
  ["ומחר", THU, "2026-10-16"],
  ["מָחָר", THU, "2026-10-16"],
  ["עד היום בערב", THU, "2026-10-15"],
  ["מחר", MONTH_END_SAT, "2026-11-01"],
  ["מחר", YEAR_END_MON, "2026-12-29"],
  ["מחר", FRI, "2026-10-17"],
  ["מחר", SUN, "2026-10-19"],

  // Weekdays: next occurrence strictly after the anchor
  ["עד יום ראשון", THU, "2026-10-18", "weekday"],
  ["יום ראשון", THU, "2026-10-18"],
  ["ביום ראשון", THU, "2026-10-18"],
  ["יום ראשון הבא", THU, "2026-10-18"],
  ["עד ראשון", THU, "2026-10-18"],
  ["יום שני", THU, "2026-10-19"],
  ["עד שני", THU, "2026-10-19"],
  ["ביום שלישי", THU, "2026-10-20"],
  ["רביעי", THU, "2026-10-21"],
  ["יום חמישי", THU, "2026-10-22"],
  ["עד שישי", THU, "2026-10-16"],
  ["בשישי", THU, "2026-10-16"],
  ["שבת", THU, "2026-10-17"],
  ["עד יום א׳", THU, "2026-10-18"],
  ["יום א'", THU, "2026-10-18"],
  ["יום ב׳", THU, "2026-10-19"],
  ["יום ה׳", THU, "2026-10-22"],
  ["יום ו׳", THU, "2026-10-16"],
  ["עד יום רביעי הקרוב", THU, "2026-10-21"],
  ["יום שישי", FRI, "2026-10-23"],
  ["שבת", FRI, "2026-10-17"],
  ["יום ראשון", FRI, "2026-10-18"],
  ["יום ראשון", SAT, "2026-10-18"],
  ["שבת", SAT, "2026-10-24"],
  ["יום ראשון", SUN, "2026-10-25"],
  ["יום חמישי", SUN, "2026-10-22"],
  ["יום ראשון", YEAR_END_MON, "2027-01-03"],

  // Weekday of next week
  ["בשבוע הבא ביום שני", THU, "2026-10-19", "weekday_next_week"],
  ["ביום ראשון בשבוע הבא", THU, "2026-10-18", "weekday_next_week"],
  ["בשבוע הבא ביום חמישי", THU, "2026-10-22"],
  ["ביום שלישי של שבוע הבא", THU, "2026-10-20"],
  ["בשבוע הבא ביום שני", SUN, "2026-10-26"],

  // Next week = next week's Thursday
  ["שבוע הבא", THU, "2026-10-22", "next_week"],
  ["בשבוע הבא", THU, "2026-10-22", "next_week"],
  ["עד סוף השבוע הבא", THU, "2026-10-22"],
  ["שבוע הבא", FRI, "2026-10-22"],
  ["שבוע הבא", SAT, "2026-10-22"],
  ["שבוע הבא", SUN, "2026-10-29"],
  ["בשבוע הבא", YEAR_END_MON, "2027-01-07"],

  // End of week = this Thursday, next week's on Friday/Saturday
  ["סוף השבוע", THU, "2026-10-15", "end_of_week"],
  ["עד סוף השבוע", THU, "2026-10-15"],
  ["השבוע", THU, "2026-10-15"],
  ["סוף השבוע", FRI, "2026-10-22"],
  ["סוף השבוע", SAT, "2026-10-22"],
  ["סוף השבוע", SUN, "2026-10-22"],
  ["סוף השבוע", MONTH_END_SAT, "2026-11-05"],
  ["סוף השבוע", YEAR_END_MON, "2026-12-31"],

  // Month periods
  ["בסוף החודש", THU, "2026-10-31", "end_of_month"],
  ["עד סוף החודש", THU, "2026-10-31"],
  ["לסוף החודש", THU, "2026-10-31"],
  ["סוף־החודש", THU, "2026-10-31"],
  ["סוֹף הַחוֹדֶשׁ", THU, "2026-10-31"],
  ["סוף החודש", MONTH_END_SAT, "2026-10-31"],
  ["סוף החודש", "2028-02-10T10:00:00+02:00", "2028-02-29"],
  ["תחילת החודש הבא", THU, "2026-11-01", "start_of_next_month"],
  ["בתחילת החודש הבא", MONTH_END_SAT, "2026-11-01"],
  ["בחודש הבא", THU, "2026-11-30", "next_month"],
  ["סוף החודש הבא", THU, "2026-11-30", "end_of_next_month"],
  ["בחודש הבא", YEAR_END_MON, "2027-01-31"],
  ["תחילת החודש הבא", YEAR_END_MON, "2027-01-01"],
  ["סוף הרבעון", THU, "2026-12-31", "end_of_quarter"],
  ["סוף הרבעון", "2026-05-03T10:00:00+03:00", "2026-06-30"],
  ["סוף השנה", THU, "2026-12-31", "end_of_year"],

  // Relative counts
  ["תוך 3 ימים", THU, "2026-10-18", "relative_count"],
  ["בעוד שבועיים", THU, "2026-10-29", "relative_count"],
  ["תוך שבוע", THU, "2026-10-22"],
  ["בעוד חודש", THU, "2026-11-15"],
  ["בעוד יומיים", THU, "2026-10-17"],
  ["תוך יום", THU, "2026-10-16"],
  ["תוך עשרה ימים", THU, "2026-10-25"],
  ["בעוד שלושה שבועות", THU, "2026-11-05"],
  ["תוך חודשיים", THU, "2026-12-15"],
  ["בעוד שנה", THU, "2027-10-15"],
  ["תוך עשרים ואחד יום", THU, "2026-11-05"],
  ["בעוד חמישה ימים", THU, "2026-10-20"],
  ["תוך שנים עשר יום", THU, "2026-10-27"],
  ["תוך 30 יום", THU, "2026-11-14"],
  ["בעוד 2 שבועות", THU, "2026-10-29"],
  ["בעוד שבועיים", YEAR_END_MON, "2027-01-11"],
  ["בעוד חודש", MONTH_END_SAT, "2026-11-30"],
  ["בעוד חודש", "2027-01-31T10:00:00+02:00", "2027-02-28"],
  ["בעוד חודש", "2028-01-31T10:00:00+02:00", "2028-02-29"],

  // Explicit dates (DMY; past day/month without a year rolls over)
  ["15/11", THU, "2026-11-15", "explicit_numeric"],
  ["15.11", THU, "2026-11-15"],
  ["עד 15.11.26", THU, "2026-11-15"],
  ["15.11.2026", THU, "2026-11-15"],
  ["ב-20.10", THU, "2026-10-20"],
  ["10.10", THU, "2027-10-10"],
  ["1/1", THU, "2027-01-01"],
  ["5/1", YEAR_END_MON, "2027-01-05"],
  ["29.2", "2027-01-10T10:00:00+02:00", "2028-02-29"],
  ["29.2.2027", THU, null],
  ["31/11", THU, null],
  ["עד ה-20", THU, "2026-10-20", "day_of_month"],
  ["ה-15 לחודש", THU, "2026-10-15", "day_of_month"],
  ["עד ה-10", THU, "2026-11-10"],
  ["עד ה15", THU, "2026-10-15"],
  ["ה-15", MONTH_END_SAT, "2026-11-15"],
  ["ה-3", YEAR_END_MON, "2027-01-03"],
  ["15 בנובמבר", THU, "2026-11-15", "explicit_month_name"],
  ["עד ה-15 בנובמבר", THU, "2026-11-15"],
  ["3 במרץ", THU, "2027-03-03"],
  ["1 בינואר 2027", THU, "2027-01-01"],
  ["2026-11-15", THU, "2026-11-15", "explicit_iso"],

  // Vague phrases
  ["אחרי החגים", THU, null],
  ["בקרוב", THU, null],
  ["בהקדם האפשרי", THU, null],
  ["מתישהו", THU, null],
  ["כשיהיה זמן", THU, null],
  ["ASAP", THU, null],
  ["", THU, null],
]

describe("parseDueDate (Hebrew)", () => {
  it("covers at least 80 Hebrew cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(80)
  })

  for (const [phrase, anchor, expected, rule] of cases) {
    it(`${JSON.stringify(phrase)} @ ${anchor.slice(0, 10)} -> ${expected}`, () => {
      const result = parseDueDate(phrase, { anchor })

      expect(result?.date ?? null).toBe(expected)
      if (rule) expect(result?.rule).toBe(rule)
    })
  }

  it("resolves the acceptance example: Thursday 15.10.2026 + 'עד יום ראשון' = 18.10.2026", () => {
    const result = parseDueDate("עד יום ראשון", { anchor: "2026-10-15T12:00:00Z" })

    expect(result).toMatchObject({ date: "2026-10-18", confidence: 0.9, rule: "weekday" })
    expect(formatDueDateDisplay(result!.date)).toBe("18.10.2026")
  })

  it("assigns the documented confidence per rule family", () => {
    expect(parseDueDate("15.11.2026", { anchor: THU })?.confidence).toBe(0.95)
    expect(parseDueDate("יום שני", { anchor: THU })?.confidence).toBe(0.9)
    expect(parseDueDate("בעוד שבועיים", { anchor: THU })?.confidence).toBe(0.85)
    expect(parseDueDate("סוף החודש", { anchor: THU })?.confidence).toBe(0.8)
  })

  it("anchors on the calendar date in the workspace time zone", () => {
    // 22:30 UTC on the 15th is 01:30 on Friday the 16th in Jerusalem.
    const late = "2026-10-15T22:30:00Z"

    expect(parseDueDate("מחר", { anchor: late })?.date).toBe("2026-10-17")
    expect(parseDueDate("מחר", { anchor: late, timeZone: "UTC" })?.date).toBe("2026-10-16")
    expect(parseDueDate("מחר", { anchor: "2026-10-15" })?.date).toBe("2026-10-16")
  })

  it("honours a custom workweek end", () => {
    expect(parseDueDate("שבוע הבא", { anchor: THU, workweekEnd: 5 })?.date).toBe("2026-10-23")
  })

  it("always reads Hebrew numeric dates day-first", () => {
    expect(parseDueDate("עד 5/11", { anchor: THU, dateOrder: "MDY" })?.date).toBe("2026-11-05")
  })

  it("returns null for an unparseable anchor", () => {
    expect(parseDueDate("מחר", { anchor: "not a date" })).toBeNull()
  })

  it("reports the matched canonical phrase", () => {
    expect(parseDueDate("לשלוח את המצגת עד יום ראשון בבוקר", { anchor: THU })).toMatchObject({
      date: "2026-10-18",
      matched: "יום ראשון",
    })
  })
})

describe("normalizeDuePhrase", () => {
  it("strips niqqud, unifies gershayim, splits maqaf and peels prefixes", () => {
    expect(normalizeDuePhrase("וּבְסוֹף הַשָּׁבוּעַ")).toBe("סוף השבוע")
    expect(normalizeDuePhrase("יום א׳")).toBe("יום א'")
    expect(normalizeDuePhrase("סוף־החודש")).toBe("סוף החודש")
    expect(normalizeDuePhrase("לסוף החודש")).toBe("סוף החודש")
    expect(normalizeDuePhrase("בעוד שבועיים")).toBe("עוד שבועיים")
    // Unknown words keep their first letter.
    expect(normalizeDuePhrase("שלחתי")).toBe("שלחתי")
  })
})

describe("date helpers", () => {
  it("computes local dates, differences, shifts and display", () => {
    expect(localDateIn("2026-10-15T22:30:00Z")).toBe("2026-10-16")
    expect(daysBetween("2026-10-15", "2026-10-18")).toBe(3)
    expect(addDaysToDate("2026-12-31", 1)).toBe("2027-01-01")
    expect(formatDueDateDisplay("2026-10-18")).toBe("18.10.2026")
  })
})
