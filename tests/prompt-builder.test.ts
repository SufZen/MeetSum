import { describe, expect, it } from "vitest"

import { buildSharedSystem } from "@/lib/ai/llm/system"
import { buildPreamble, resolveOutputLanguage, shouldEscalateTranscription } from "@/lib/ai/policy"
import { getStyleGuide, UNCLEAR_MARKER_HE } from "@/lib/ai/prompts/style-guide"
import {
  buildSummaryInstructions,
  chapterTarget,
  formatMeetingDate,
  languageRetryInstruction,
} from "@/lib/ai/prompts/summary"
import { buildTitleInstructions } from "@/lib/ai/prompts/title"
import { PROMPT_VERSION } from "@/lib/ai/prompts/version"
import { BUILT_IN_TEMPLATES } from "@/lib/ai/templates/builtins"

const BIDI_CONTROLS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/

describe("Hebrew prompting", () => {
  it("has a versioned prompt set", () => {
    expect(PROMPT_VERSION).toBe("m5.1")
  })

  it("the Hebrew style guide covers register, gender-neutral phrasing, tech terms, dates and money", () => {
    const guide = getStyleGuide("he")

    expect(guide).toContain("לשון ניטרלית")
    expect(guide).toContain("אסור להניח לשון זכר")
    expect(guide).toContain("Supabase, API, PR")
    expect(guide).toContain("DD.MM.YYYY")
    expect(guide).toContain("1,200 ₪")
    expect(guide).toContain(UNCLEAR_MARKER_HE)
    expect(guide).toContain("דוגמה (סינתטית")
    expect(guide).not.toMatch(BIDI_CONTROLS)
    expect(getStyleGuide("en")).toContain("never assume a gender")
  })

  it("the shared system prefix holds preamble, style guide and transcript only", () => {
    const system = buildSharedSystem({ language: "he", sharedContext: "[s1 00:00 דנה] שלום" })

    expect(system.startsWith(buildPreamble("he"))).toBe(true)
    expect(system).toContain(getStyleGuide("he"))
    expect(system.endsWith("<transcript>\n[s1 00:00 דנה] שלום\n</transcript>")).toBe(true)
    expect(buildPreamble("he")).not.toMatch(/\d{4}-\d{2}-\d{2}/)
  })

  it("builds Hebrew summary instructions with the date anchor and template sections", () => {
    const prompt = buildSummaryInstructions({
      language: "he",
      template: BUILT_IN_TEMPLATES.hebrew_business,
      meetingTitle: "סנכרון שבועי",
      startedAt: "2026-10-15T07:00:00.000Z",
      participants: ["דנה", "יואב"],
      durationMs: 3_600_000,
    })

    expect(prompt).toContain("תאריך הפגישה: יום חמישי, 15.10.2026")
    expect(prompt).toContain("משתתפים: דנה, יואב")
    expect(prompt).toContain("numbers_dates — מספרים ותאריכים שהוזכרו")
    expect(prompt).toContain("refs")
    expect(prompt).toContain("3–12 פרקים")
    // Reserved sections come from the core fields, not the model.
    expect(prompt).not.toContain("- decisions — החלטות")
    expect(prompt).not.toMatch(BIDI_CONTROLS)
  })

  it("writes English instructions for English output", () => {
    const prompt = buildSummaryInstructions({
      language: "en",
      template: BUILT_IN_TEMPLATES.sales,
      meetingTitle: "Acme call",
      startedAt: "2026-10-18T09:00:00.000Z",
      participants: [],
      durationMs: 20 * 60_000,
    })

    expect(prompt).toContain("Meeting date: Sunday, 18.10.2026")
    expect(prompt).toContain("Lead qualification")
    expect(prompt).toContain("objections — Objections and responses (qa) (at most 8 items)")
  })

  it("formats dates in the meeting time zone", () => {
    expect(formatMeetingDate("2026-10-15T22:30:00.000Z", "he")).toBe("יום שישי, 16.10.2026")
    expect(formatMeetingDate("2026-10-15T22:30:00.000Z", "en", "UTC")).toBe("Thursday, 15.10.2026")
  })

  it("targets 3-12 chapters per hour", () => {
    expect(chapterTarget(3_600_000)).toEqual({ min: 3, max: 12 })
    expect(chapterTarget(10 * 60_000)).toEqual({ min: 1, max: 2 })
  })

  it("has Hebrew title and language-retry instructions", () => {
    expect(buildTitleInstructions({ language: "he", currentTitle: "x", participants: [] })).toContain(
      "עד 60 תווים"
    )
    expect(languageRetryInstruction("he")).toContain("בעברית בלבד")
  })
})

describe("output language", () => {
  const hebrew = [{ text: "שלום לכולם, נתחיל בעדכון" }]
  const english = [{ text: "Hello everyone, let's start with the update" }]

  it("uses the meeting's primary language by default", () => {
    expect(resolveOutputLanguage({ languageMetadata: { primaryLanguage: "en" } })).toBe("en")
    expect(resolveOutputLanguage({ language: "he" })).toBe("he")
  })

  it("forces he/en by mode and honors the run override", () => {
    expect(resolveOutputLanguage({ language: "en" }, { summaryLanguageMode: "he" })).toBe("he")
    expect(resolveOutputLanguage({ language: "he" }, { summaryLanguageMode: "he" }, "en")).toBe("en")
  })

  it("picks Hebrew for mixed meetings at >= 30% Hebrew letters", () => {
    // 9 Hebrew letters of 29 (31%) vs 4 of 16 (25%).
    const mixed = [{ text: "Let's sync on the roadmap היום בבוקר" }]
    const mostlyEnglish = [{ text: "We need the API שלום" }]

    expect(resolveOutputLanguage({ transcript: hebrew }, { summaryLanguageMode: "mixed" })).toBe("he")
    expect(resolveOutputLanguage({ transcript: english }, { summaryLanguageMode: "mixed" })).toBe("en")
    expect(
      resolveOutputLanguage({ languageMetadata: { primaryLanguage: "mixed" }, transcript: mixed })
    ).toBe("he")
    expect(
      resolveOutputLanguage({ languageMetadata: { primaryLanguage: "mixed" }, transcript: mostlyEnglish })
    ).toBe("en")
  })

  it("falls back to Hebrew when unknown", () => {
    expect(resolveOutputLanguage({})).toBe("he")
    expect(resolveOutputLanguage({ language: "xx" })).toBe("he")
  })

  it("keeps the transcription escalation thresholds", () => {
    expect(shouldEscalateTranscription({ language: "he", confidence: 0.87 })).toBe(true)
    expect(shouldEscalateTranscription({ language: "en", confidence: 0.85 })).toBe(false)
  })
})
