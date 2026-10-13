import { describe, expect, it } from "vitest"

import {
  cleanAiTitle,
  isGenericMeetingTitle,
  normalizeAutoTitleMode,
  shouldApplyAiTitle,
} from "@/lib/intelligence/title"

describe("auto title", () => {
  it.each([
    "",
    "Untitled",
    "Untitled meeting",
    "Meeting",
    "New recording 3",
    "Zoom Meeting",
    "פגישה ללא שם",
    "פגישה",
    "הקלטה חדשה",
    "recording.m4a",
    "Weekly sync.mp4",
    "GMT20261013-090000_Recording",
    "2026-10-13 09:30",
    "Meeting 13.10.2026",
  ])("treats %j as generic", (title) => {
    expect(isGenericMeetingTitle(title)).toBe(true)
  })

  it.each(["Weekly sync with Acme", "סקירת תקציב רבעון 4", "Board meeting Q3"])(
    "keeps %j",
    (title) => {
      expect(isGenericMeetingTitle(title)).toBe(false)
    }
  )

  it("generic_only replaces generic titles and earlier AI titles, never user titles", () => {
    expect(shouldApplyAiTitle({ mode: "generic_only", title: "Untitled", titleSource: "source" })).toBe(true)
    expect(shouldApplyAiTitle({ mode: "generic_only", title: "Acme sync", titleSource: "source" })).toBe(false)
    expect(shouldApplyAiTitle({ mode: "generic_only", title: "Acme sync", titleSource: "ai" })).toBe(true)
    expect(shouldApplyAiTitle({ mode: "generic_only", title: "Untitled", titleSource: "user" })).toBe(false)
  })

  it("always replaces anything except a user title; off never does", () => {
    expect(shouldApplyAiTitle({ mode: "always", title: "Acme sync" })).toBe(true)
    expect(shouldApplyAiTitle({ mode: "always", title: "Acme sync", titleSource: "user" })).toBe(false)
    expect(shouldApplyAiTitle({ mode: "off", title: "Untitled" })).toBe(false)
  })

  it("normalizes the mode and cleans titles to 60 chars", () => {
    expect(normalizeAutoTitleMode("bogus")).toBe("generic_only")
    expect(cleanAiTitle('  "סנכרון שבועי"  ')).toBe("סנכרון שבועי")
    const long = "פגישת תכנון רבעונית עם צוות המוצר וההנדסה לגבי מפת הדרכים של 2027 והשקת הגרסה"
    const cleaned = cleanAiTitle(long)

    expect(cleaned.length).toBeLessThanOrEqual(60)
    expect(long.startsWith(cleaned)).toBe(true)
    expect(cleaned.endsWith(" ")).toBe(false)
  })
})
