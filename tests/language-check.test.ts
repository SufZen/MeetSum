import { describe, expect, it } from "vitest"

import { checkOutputLanguage, hebrewRatio, summaryProse } from "@/lib/intelligence/language-check"

describe("output language check", () => {
  it("passes Hebrew prose that keeps Latin tech terms", () => {
    const text =
      "הוחלט להעביר את ה-API ל-Supabase עד סוף החודש. יואב יכין PR ויעדכן את ה-dashboard ב-GitHub לפני ה-release של v2.1."

    expect(hebrewRatio(text)).toBeGreaterThan(0.9)
    expect(checkOutputLanguage(text, "he")).toMatchObject({ passed: true, checked: true })
  })

  it("fails an English summary for a Hebrew meeting", () => {
    const text = "The team decided to migrate the API to Supabase by the end of the month."

    expect(checkOutputLanguage(text, "he").passed).toBe(false)
  })

  it("checks English output allows at most 10% Hebrew", () => {
    expect(checkOutputLanguage("The client, דנה, approved the quote of $1,200 for the pilot.", "en").passed).toBe(true)
    expect(checkOutputLanguage("סיכום הפגישה: הלקוח אישר את ההצעה.", "en").passed).toBe(false)
  })

  it("respects extra glossary terms", () => {
    const text = "צריך לעדכן Meetsum Realization Cadence"

    expect(hebrewRatio(text)).toBeLessThan(0.6)
    expect(hebrewRatio(text, ["Meetsum", "Realization", "Cadence"])).toBe(1)
  })

  it("skips other languages and empty text", () => {
    expect(checkOutputLanguage("Resumo da reunião", "pt")).toEqual({ passed: true, ratio: 0, checked: false })
    expect(checkOutputLanguage("123", "he").checked).toBe(false)
    expect(checkOutputLanguage("API PR", "he").passed).toBe(true)
  })

  it("collects model-written prose only", () => {
    const prose = summaryProse({
      overview: "תקציר",
      sections: [{ text: "פסקה", items: [{ text: "פריט" }] }],
      decisions: [{ text: "החלטה" }],
      chapters: [{ title: "פרק", summary: "תיאור", bullets: ["נקודה"] }],
      actionItems: [{ title: "משימה" }],
    })

    expect(prose.split("\n")).toEqual(["תקציר", "פסקה", "פריט", "החלטה", "פרק", "תיאור", "נקודה", "משימה"])
  })
})
