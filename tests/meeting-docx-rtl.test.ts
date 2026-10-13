import JSZip from "jszip"
import { describe, expect, it } from "vitest"

import { exportLocaleFor, renderMeetingDocx, renderMeetingMarkdown } from "@/lib/meetings/export"
import type { MeetingRecord } from "@/lib/meetings/repository"

/**
 * M8 C3: DOCX with real RTL paragraphs. Hebrew paragraphs carry `<w:bidi/>`
 * and Hebrew runs `<w:rtl/>`; English meetings carry neither; timecodes and
 * emails are LTR runs isolated with U+2066…U+2069.
 */

const LRI = "⁦"
const PDI = "⁩"

function hebrewMeeting(overrides: Partial<MeetingRecord> = {}): MeetingRecord {
  return {
    id: "m_he",
    title: "פגישת צוות",
    source: "upload",
    language: "he",
    status: "completed",
    retention: "audio",
    startedAt: "2026-10-01T07:30:00.000Z",
    participants: [],
    participantDetails: [
      {
        id: "p1",
        meetingId: "m_he",
        name: "דנה",
        email: "dana@example.com",
        role: "organizer",
        source: "calendar",
        attendanceStatus: "accepted",
        createdAt: "",
        updatedAt: "",
      },
    ],
    summary: {
      overview: "דנו בתוכנית הרבעון ובשחרור של MeetSum v2.",
      decisions: ["משחררים בספטמבר"],
      actionItems: [{ id: "a1", title: "לשלוח את התוכנית", owner: "דנה", status: "open", dueDate: "2026-10-05" }],
    },
    transcript: [
      { id: "t1", startMs: 12_000, endMs: 15_000, speaker: "דנה", text: "בואו נתחיל" },
      { id: "t2", startMs: 75_000, endMs: 80_000, speaker: "Alex", text: "Sounds good", language: "en" },
    ],
    ...overrides,
  }
}

function englishMeeting(): MeetingRecord {
  return hebrewMeeting({
    id: "m_en",
    title: "Weekly sync",
    language: "en",
    participantDetails: undefined,
    participants: ["Alex"],
    summary: {
      overview: "We discussed the roadmap.",
      decisions: ["Ship in September"],
      actionItems: [{ id: "a1", title: "Send the plan", owner: "Alex", status: "open" }],
    },
    transcript: [{ id: "t1", startMs: 0, endMs: 1_000, speaker: "Alex", text: "Let's start" }],
  })
}

async function documentXml(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer)

  return (await zip.file("word/document.xml")?.async("string")) ?? ""
}

/** `<w:p>…</w:p>` blocks containing `needle`. */
function paragraphsWith(xml: string, needle: string): string[] {
  return (xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []).filter((paragraph) => paragraph.includes(needle))
}

/** `<w:r>…</w:r>` runs whose text contains `needle`. */
function runsWith(xml: string, needle: string): string[] {
  return (xml.match(/<w:r>[\s\S]*?<\/w:r>|<w:r [\s\S]*?<\/w:r>/g) ?? []).filter((run) => run.includes(needle))
}

describe("renderMeetingDocx (Hebrew RTL)", () => {
  it("marks Hebrew paragraphs bidi and Hebrew runs rtl, with complex-script font and he-IL", async () => {
    const xml = await documentXml(await renderMeetingDocx(hebrewMeeting(), { locale: "he" }))
    const overview = paragraphsWith(xml, "דנו בתוכנית")[0] ?? ""
    const hebrewRun = runsWith(xml, "דנו בתוכנית")[0] ?? ""

    expect(overview).toContain("<w:bidi/>")
    expect(overview).toMatch(/<w:jc w:val="start"\/>/)
    expect(hebrewRun).toContain("<w:rtl/>")
    expect(hebrewRun).toMatch(/<w:rFonts [^>]*w:cs="Arial"/)
    expect(hebrewRun).toMatch(/<w:lang [^>]*w:bidi="he-IL"/)
    expect(hebrewRun).toContain("<w:szCs ")
  })

  it("keeps an English word inside a Hebrew paragraph in its own LTR run (mixed he/en)", async () => {
    const xml = await documentXml(await renderMeetingDocx(hebrewMeeting(), { locale: "he" }))
    const latin = runsWith(xml, "MeetSum v2")[0] ?? ""

    expect(latin).not.toBe("")
    expect(latin).not.toContain("<w:rtl/>")
    expect(paragraphsWith(xml, "MeetSum v2")[0]).toContain("<w:bidi/>")
  })

  it("localizes headings and isolates timecodes and emails as LTR runs", async () => {
    const xml = await documentXml(await renderMeetingDocx(hebrewMeeting(), { locale: "he" }))

    for (const heading of ["סקירה", "החלטות", "משימות", "תמליל"]) {
      expect(xml, heading).toContain(`>${heading}<`)
    }
    expect(xml).not.toContain(">Overview<")

    const timecode = runsWith(xml, `${LRI}00:12${PDI}`)[0] ?? ""
    const email = runsWith(xml, `${LRI}dana@example.com${PDI}`)[0] ?? ""

    expect(timecode).not.toBe("")
    expect(timecode).not.toContain("<w:rtl/>")
    expect(email).not.toBe("")
    expect(email).not.toContain("<w:rtl/>")
  })

  it("follows the segment language: an English segment in a Hebrew meeting is LTR", async () => {
    const xml = await documentXml(await renderMeetingDocx(hebrewMeeting(), { locale: "he" }))
    const english = paragraphsWith(xml, "Sounds good")[0] ?? ""
    const hebrew = paragraphsWith(xml, "בואו נתחיל")[0] ?? ""

    expect(english).not.toContain("<w:bidi/>")
    expect(hebrew).toContain("<w:bidi/>")
  })

  it("adds no bidi or rtl to an English meeting", async () => {
    const xml = await documentXml(await renderMeetingDocx(englishMeeting()))

    expect(xml).not.toContain("<w:bidi/>")
    expect(xml).not.toContain("<w:rtl/>")
    expect(xml).toContain(">Overview<")
  })

  it("formats the date with Intl in the task time zone", async () => {
    const xml = await documentXml(
      await renderMeetingDocx(hebrewMeeting(), {
        locale: "en",
        env: { MEETSUM_DEFAULT_TIMEZONE: "Asia/Jerusalem" } as NodeJS.ProcessEnv,
      })
    )

    // 07:30 UTC is 10:30 in Jerusalem (IDT).
    expect(xml).toMatch(/10:30/)
  })
})

describe("renderMeetingMarkdown localized headings", () => {
  it("uses Hebrew headings and RTL-safe lines for locale he", () => {
    const md = renderMeetingMarkdown(hebrewMeeting(), { locale: "he" })

    expect(md).toContain("## סקירה")
    expect(md).toContain("## החלטות")
    expect(md).toContain("## משימות")
    expect(md).toContain("## תמליל")
    expect(md).toContain("דנה: בואו נתחיל")
  })

  it("keeps English headings by default", () => {
    expect(renderMeetingMarkdown(hebrewMeeting())).toContain("## Overview")
  })
})

describe("exportLocaleFor", () => {
  it("honours an explicit he/en locale, else the meeting language", () => {
    expect(exportLocaleFor({ language: "en" }, "he")).toBe("he")
    expect(exportLocaleFor({ language: "he" }, "fr")).toBe("he")
    expect(exportLocaleFor({ language: "he-IL" }, null)).toBe("he")
    expect(exportLocaleFor({ language: "en" }, undefined)).toBe("en")
  })
})
