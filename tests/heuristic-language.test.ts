import { describe, expect, it } from "vitest"

import { buildMeetingIntelligence } from "@/lib/intelligence"

const base = {
  id: "m_1",
  title: "סנכרון שבועי",
  source: "upload" as const,
  status: "completed" as const,
  retention: "audio" as const,
  startedAt: "2026-10-15T09:00:00.000Z",
  participants: [],
}

describe("heuristic summary language", () => {
  it("writes the overview and follow-up in Hebrew for a Hebrew meeting", () => {
    const intelligence = buildMeetingIntelligence({
      ...base,
      language: "he",
      transcript: [{ id: "s1", speaker: "דנה", startMs: 0, endMs: 3000, text: "נשלח את ההצעה עד יום ראשון" }],
    })

    expect(intelligence.overview).toContain("קטעי תמלול")
    expect(intelligence.overview).not.toMatch(/cleaned transcript segments/)
    expect(intelligence.followUpDraft.startsWith("מעקב עבור")).toBe(true)
  })

  it("keeps English for an English meeting", () => {
    const intelligence = buildMeetingIntelligence({
      ...base,
      title: "Weekly sync",
      language: "en",
      transcript: [{ id: "s1", speaker: "Dana", startMs: 0, endMs: 3000, text: "We will send the proposal" }],
    })

    expect(intelligence.overview).toContain("cleaned transcript segments")
  })
})
