import { describe, expect, it } from "vitest"

import { RLM } from "@/lib/integrations/bidi"
import { HUBSPOT_BODY_MAX, escapeHtml, renderHubspotNoteHtml } from "@/lib/integrations/hubspot/note-html"
import type { MeetingRecap } from "@/lib/integrations/recap"

function recap(overrides: Partial<MeetingRecap> = {}): MeetingRecap {
  return {
    meetingId: "meet_1",
    title: "פגישה",
    language: "he",
    dir: "rtl",
    startedAt: "2026-10-13T09:00:00.000Z",
    participants: [],
    overview: "שורה ראשונה\nAPI v2 <b>bold</b> & \"quotes\"",
    actionItems: [{ id: "a1", title: "לשלוח <img src=x onerror=alert(1)>", owner: "דנה", dueDate: "2026-10-20", status: "open" }],
    decisions: ["החלטה 1"],
    openQuestions: [],
    links: { meeting: "https://meetsum.example/he?meeting=meet_1" },
    visibility: "workspace",
    ...overrides,
  }
}

describe("renderHubspotNoteHtml", () => {
  it("escapes all meeting text (no markup from content reaches HubSpot)", () => {
    const html = renderHubspotNoteHtml(recap())

    expect(html).not.toContain("<b>")
    expect(html).not.toContain("<img")
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt; &amp; &quot;quotes&quot;")
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;")
    expect(escapeHtml(`'<>&"`)).toBe("&#39;&lt;&gt;&amp;&quot;")
  })

  it("wraps Hebrew in dir=rtl and prefixes every text line with RLM", () => {
    const html = renderHubspotNoteHtml(recap())

    expect(html.startsWith('<div dir="rtl">')).toBe(true)
    expect(html).toContain(`${RLM}API v2`)
    expect(html).toContain(`${RLM}שורה ראשונה`)
    expect(html).toContain(`<h3>${RLM}סיכום</h3>`)
    expect(html).toContain(`>${RLM}פתיחה ב-MeetSum</a>`)
    expect(html).toContain(`${RLM}החלטה 1`)
  })

  it("keeps English LTR without marks", () => {
    const html = renderHubspotNoteHtml(recap({ language: "en", dir: "ltr", overview: "Plan agreed", actionItems: [], decisions: [] }))

    expect(html.startsWith("<div>")).toBe(true)
    expect(html).not.toContain(RLM)
    expect(html).toContain("<h3>Summary</h3><p>Plan agreed</p>")
  })

  it("links only https URLs", () => {
    expect(renderHubspotNoteHtml(recap({ links: { meeting: "javascript:alert(1)" } }))).not.toContain("href")
  })

  it("stays within the 60,000-character body limit", () => {
    const html = renderHubspotNoteHtml(
      recap({
        overview: "א<".repeat(40_000),
        decisions: Array.from({ length: 2000 }, (_, index) => `החלטה ${index}`),
      })
    )

    expect(html.length).toBeLessThanOrEqual(HUBSPOT_BODY_MAX)
    expect(html).toContain("(קוצר)")
    expect(html.endsWith("</div>")).toBe(true)
    expect(html).not.toMatch(/&[a-z]*<\/p>/)
  })
})
