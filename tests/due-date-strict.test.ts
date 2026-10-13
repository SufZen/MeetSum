import { describe, expect, it } from "vitest"

import { parseDueDate } from "@/lib/tasks/due-date"
import { resolveDuePatch } from "@/lib/tasks/patch"

const anchor = "2026-10-15T09:00:00.000Z" // Thursday

/**
 * User-typed due phrases are parsed strictly: junk around the date ("e148
 * מחר") is rejected instead of silently becoming a date. Filler words
 * ("עד", "by", "on"…) are fine. AI-extracted text keeps the lenient parse.
 */
describe("strict due-date parsing", () => {
  it.each(["e148 מחר", "asdf tomorrow", "מחר qwerty", "tomorrow 12345x"])("rejects %j", (phrase) => {
    expect(parseDueDate(phrase, { anchor, strict: true })).toBeNull()
  })

  it.each([
    ["מחר", "2026-10-16"],
    ["עד מחר", "2026-10-16"],
    ["עד יום ראשון", "2026-10-18"],
    ["by Friday", "2026-10-16"],
    ["tomorrow", "2026-10-16"],
    ["due by tomorrow", "2026-10-16"],
  ])("accepts %j", (phrase, expected) => {
    expect(parseDueDate(phrase, { anchor, strict: true })?.date).toBe(expected)
  })

  it("keeps the lenient parse for free text (AI extraction)", () => {
    expect(parseDueDate("e148 מחר", { anchor })?.date).toBe("2026-10-16")
  })

  it("a user PATCH with a junk phrase sets no due date", () => {
    expect(resolveDuePatch({ dueText: "e148 מחר" }, anchor, "Asia/Jerusalem")).toMatchObject({ dueOn: null })
  })
})
