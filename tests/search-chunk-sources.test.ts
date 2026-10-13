import { createHash } from "node:crypto"

import { describe, expect, it } from "vitest"

import type { MeetingIntelligence } from "@/lib/intelligence/types"
import type { MeetingRecord } from "@/lib/meetings/repository"
import { buildChunkSources } from "@/lib/search/chunk-sources"

function intelligence(overrides: Partial<MeetingIntelligence> = {}): MeetingIntelligence {
  return {
    overview: "סקרנו את התקציב של הרבעון.",
    decisions: [],
    actionItems: [],
    risks: [],
    openQuestions: [],
    commitments: [],
    followUpDraft: "",
    timestampedQuotes: [],
    tags: ["finance"],
    languageMetadata: {
      primaryLanguage: "he",
      secondaryLanguages: [],
      segmentLanguages: [],
      confidence: 0.9,
      mixedLanguage: false,
    },
    version: 2,
    meetingType: "budget_review",
    ...overrides,
  }
}

function meeting(overrides: Partial<MeetingRecord> = {}): MeetingRecord {
  return {
    id: "m1",
    title: "סקירת תקציב Q3",
    source: "upload",
    language: "he",
    status: "completed",
    retention: "audio",
    startedAt: "2026-10-12T07:30:00.000Z",
    participants: ["dana@example.com"],
    participantDetails: [
      {
        id: "p1",
        meetingId: "m1",
        name: "דנה כהן",
        email: "dana@example.com",
        role: "organizer",
        source: "calendar",
        attendanceStatus: "accepted",
        createdAt: "",
        updatedAt: "",
      },
    ],
    speakers: [
      {
        id: "sp_a",
        meetingId: "m1",
        label: "Speaker 1",
        displayName: "אבי לוי",
        mappingStatus: "confirmed",
        source: "asr",
        talkTimeMs: 0,
        wordCount: 0,
        segmentCount: 0,
      },
    ],
    tags: ["finance"],
    contexts: [{ id: "ctx_1", name: "הנהלה", createdAt: "" }],
    intelligence: intelligence({
      sections: [{ key: "risks", title: "סיכונים", text: "עלייה בעלויות הענן.", itemIds: [] }],
      items: [
        { id: "si_1", kind: "decision", text: "מאשרים את התקציב.", refs: [{ segmentId: "seg_3", startMs: 15_000 }] },
        { id: "si_2", kind: "risk", text: "חריגה אפשרית בענן.", refs: [{ segmentId: "seg_7", startMs: 35_000 }] },
        { id: "si_3", kind: "section_item", text: "פריט של תבנית", refs: [] },
      ],
      chapters: [
        {
          id: "ch_1",
          title: "פתיחה",
          summary: "הצגת המטרות.",
          startMs: 0,
          endMs: 60_000,
          startSegmentId: "seg_0",
          bullets: [],
        },
      ],
    }),
    summary: {
      overview: "סקרנו את התקציב של הרבעון.",
      decisions: [],
      actionItems: [
        {
          id: "ai_1",
          title: "לשלוח את התקציב המעודכן",
          owner: "דנה כהן",
          status: "open",
          dueText: "עד יום ראשון",
          sourceStartMs: 42_000,
          sourceSegmentId: "seg_8",
        },
      ],
    },
    ...overrides,
  }
}

const sha = (kind: string, text: string) => createHash("sha256").update(`${kind}\0${text}`).digest("hex")

describe("buildChunkSources", () => {
  it("builds the meta chunk: title, date, people, speakers, tags, rooms, type", () => {
    const meta = buildChunkSources(meeting()).find((chunk) => chunk.kind === "meta")

    expect(meta).toBeDefined()
    expect(meta?.text).toContain("סקירת תקציב Q3")
    expect(meta?.text).toContain("12.10.2026")
    expect(meta?.text).toContain("דנה כהן")
    expect(meta?.text).toContain("אבי לוי")
    expect(meta?.text).toContain("finance")
    expect(meta?.text).toContain("הנהלה")
    expect(meta?.text).toContain("budget_review")
    expect(meta?.chunkIndex).toBe(0)
    expect(meta?.contentHash).toBe(sha("meta", meta?.text ?? ""))
    expect(meta?.textNorm).toContain("q3")
  })

  it("builds the summary from the overview and template sections", () => {
    const summary = buildChunkSources(meeting()).filter((chunk) => chunk.kind === "summary")

    expect(summary).toHaveLength(1)
    expect(summary[0].text).toContain("סקרנו את התקציב")
    expect(summary[0].text).toContain("סיכונים: עלייה בעלויות הענן.")
    expect(summary[0].language).toBe("he")
  })

  it("splits a long summary at the max", () => {
    const overview = Array.from({ length: 400 }, (_, index) => `משפט ${index} על התקציב.`).join(" ")
    const summary = buildChunkSources(meeting({ intelligence: intelligence({ overview }) }), { maxTokens: 200 }).filter(
      (chunk) => chunk.kind === "summary"
    )

    expect(summary.length).toBeGreaterThan(3)
    summary.forEach((chunk, index) => {
      expect(chunk.chunkIndex).toBe(index)
      expect(chunk.tokenEstimate).toBeLessThanOrEqual(200)
    })
  })

  it("packs citable items with their refs (section items excluded)", () => {
    const [items] = buildChunkSources(meeting()).filter((chunk) => chunk.kind === "item")

    expect(items.text).toContain("מאשרים את התקציב.")
    expect(items.text).toContain("חריגה אפשרית בענן.")
    expect(items.text).not.toContain("פריט של תבנית")
    expect(items.segmentIds).toEqual(["seg_3", "seg_7"])
    expect(items.segmentStartMs).toEqual([15_000, 35_000])
    expect(items.text.slice(items.segmentOffsets[1]).startsWith("חריגה")).toBe(true)
    expect(items.startMs).toBe(15_000)
  })

  it("falls back to legacy decision/risk arrays without V2 items", () => {
    const legacy = meeting({
      intelligence: intelligence({ decisions: ["החלטה ישנה"], risks: ["סיכון ישן"], version: undefined }),
    })
    const [items] = buildChunkSources(legacy).filter((chunk) => chunk.kind === "item")

    expect(items.text).toContain("החלטה ישנה")
    expect(items.text).toContain("סיכון ישן")
    expect(items.segmentIds).toEqual([])
  })

  it("builds one chunk per action item with owner, due text and source", () => {
    const actions = buildChunkSources(meeting()).filter((chunk) => chunk.kind === "action_item")

    expect(actions).toHaveLength(1)
    expect(actions[0].sourceId).toBe("ai_1")
    expect(actions[0].text).toContain("לשלוח את התקציב המעודכן")
    expect(actions[0].text).toContain("דנה כהן")
    expect(actions[0].text).toContain("עד יום ראשון")
    expect(actions[0].startMs).toBe(42_000)
    expect(actions[0].segmentIds).toEqual(["seg_8"])
  })

  it("builds chapter chunks with their start", () => {
    const [chapter] = buildChunkSources(meeting()).filter((chunk) => chunk.kind === "chapter")

    expect(chapter.text).toBe("פתיחה\nהצגת המטרות.")
    expect(chapter.sourceId).toBe("ch_1")
    expect(chapter.startMs).toBe(0)
    expect(chapter.endMs).toBe(60_000)
    expect(chapter.segmentIds).toEqual(["seg_0"])
  })

  it("still builds the meta chunk without intelligence, and is deterministic", () => {
    const bare = meeting({ intelligence: undefined, summary: undefined })
    const chunks = buildChunkSources(bare)

    expect(chunks.map((chunk) => chunk.kind)).toEqual(["meta"])
    expect(buildChunkSources(meeting())).toEqual(buildChunkSources(meeting()))
  })
})
