import { describe, expect, it } from "vitest"

import { parseDueDate } from "@/lib/tasks/due-date"

/** English due-date matrix (docs/parity/m5.md B1). Thu 15 Oct 2026 anchor. */
const THU = "2026-10-15T09:00:00+03:00"
const FRI = "2026-10-16T09:00:00+03:00"
const YEAR_END_MON = "2026-12-28T10:00:00+02:00"

type Case = [phrase: string, anchor: string, expected: string | null, order?: "DMY" | "MDY"]

const cases: Case[] = [
  ["today", THU, "2026-10-15"],
  ["tonight", THU, "2026-10-15"],
  ["EOD", THU, "2026-10-15"],
  ["by end of day", THU, "2026-10-15"],
  ["tomorrow", THU, "2026-10-16"],
  ["by tomorrow morning", THU, "2026-10-16"],
  ["the day after tomorrow", THU, "2026-10-17"],
  ["by Monday", THU, "2026-10-19"],
  ["on Friday", THU, "2026-10-16"],
  ["next Tuesday", THU, "2026-10-20"],
  ["Thursday", THU, "2026-10-22"],
  ["Mon", THU, "2026-10-19"],
  ["by wed", THU, "2026-10-21"],
  ["Friday", FRI, "2026-10-23"],
  ["Monday next week", THU, "2026-10-19"],
  ["next week on Wednesday", THU, "2026-10-21"],
  ["next week", THU, "2026-10-22"],
  ["next week", YEAR_END_MON, "2027-01-07"],
  ["end of the week", THU, "2026-10-15"],
  ["by the end of the week", FRI, "2026-10-22"],
  ["EOW", THU, "2026-10-15"],
  ["end of month", THU, "2026-10-31"],
  ["EOM", THU, "2026-10-31"],
  ["by the end of next month", THU, "2026-11-30"],
  ["beginning of next month", THU, "2026-11-01"],
  ["next month", THU, "2026-11-30"],
  ["end of the quarter", THU, "2026-12-31"],
  ["end of year", THU, "2026-12-31"],
  ["in 3 days", THU, "2026-10-18"],
  ["in two weeks", THU, "2026-10-29"],
  ["within two weeks", THU, "2026-10-29"],
  ["in a week", THU, "2026-10-22"],
  ["in a month", THU, "2026-11-15"],
  ["within 10 days", THU, "2026-10-25"],
  ["in twenty-one days", THU, "2026-11-05"],
  ["in a couple of days", THU, "2026-10-17"],
  ["Nov 15", THU, "2026-11-15"],
  ["November 15th, 2026", THU, "2026-11-15"],
  ["15 Nov", THU, "2026-11-15"],
  ["the 15th of November", THU, "2026-11-15"],
  ["March 3", THU, "2027-03-03"],
  ["Jan 5", YEAR_END_MON, "2027-01-05"],
  ["by the 20th", THU, "2026-10-20"],
  ["the 10th", THU, "2026-11-10"],
  ["2026-11-15", THU, "2026-11-15"],
  ["15/11", THU, "2026-11-15", "DMY"],
  ["11/15", THU, "2026-11-15", "MDY"],
  ["11/15/2026", THU, "2026-11-15", "MDY"],
  ["05/11", THU, "2026-11-05", "DMY"],
  ["05/11", THU, "2027-05-11", "MDY"],
  ["15/11", THU, null, "MDY"],
  ["ASAP", THU, null],
  ["soon", THU, null],
  ["later", THU, null],
  ["in a few days", THU, null],
  ["when possible", THU, null],
  ["at some point", THU, null],
]

describe("parseDueDate (English)", () => {
  it("covers at least 30 English cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(30)
  })

  for (const [phrase, anchor, expected, order] of cases) {
    it(`${JSON.stringify(phrase)}${order ? ` [${order}]` : ""} @ ${anchor.slice(0, 10)} -> ${expected}`, () => {
      expect(parseDueDate(phrase, { anchor, dateOrder: order })?.date ?? null).toBe(expected)
    })
  }

  it("does not mistake words for weekday abbreviations", () => {
    expect(parseDueDate("we sat down to plan", { anchor: THU })).toBeNull()
  })

  it("uses the documented confidences", () => {
    expect(parseDueDate("Nov 15", { anchor: THU })?.confidence).toBe(0.95)
    expect(parseDueDate("by Monday", { anchor: THU })?.confidence).toBe(0.9)
    expect(parseDueDate("in 3 days", { anchor: THU })?.confidence).toBe(0.85)
    expect(parseDueDate("EOM", { anchor: THU })?.confidence).toBe(0.8)
  })
})
