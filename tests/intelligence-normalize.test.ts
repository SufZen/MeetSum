import { createHash } from "node:crypto"

import { describe, expect, it } from "vitest"

import { normalizeIntelligence, sha1Hex, summaryItemId } from "@/lib/intelligence/normalize"
import { normalizeTaskTitle } from "@/lib/meetings/action-item-merge"

describe("sha1Hex", () => {
  it("matches node:crypto for ASCII, Hebrew and block-boundary inputs", () => {
    for (const input of ["", "abc", "דנה תשלח את המצגת", "x".repeat(55), "y".repeat(64), "z".repeat(119)]) {
      expect(sha1Hex(input)).toBe(createHash("sha1").update(input, "utf8").digest("hex"))
    }
  })
})

describe("summaryItemId", () => {
  it("is si_ + 12 hex chars of sha1(kind + normalized text)", () => {
    const text = "  Ship the API by Thursday!  "
    const expected = createHash("sha1")
      .update(`decision${normalizeTaskTitle(text)}`, "utf8")
      .digest("hex")
      .slice(0, 12)

    expect(summaryItemId("decision", text)).toBe(`si_${expected}`)
  })

  it("is stable across punctuation/case and differs by kind", () => {
    expect(summaryItemId("risk", "Budget overrun.")).toBe(summaryItemId("risk", "budget OVERRUN"))
    expect(summaryItemId("risk", "Budget overrun")).not.toBe(
      summaryItemId("decision", "Budget overrun")
    )
  })
})

describe("normalizeIntelligence", () => {
  it("fills every legacy field for empty or invalid input", () => {
    for (const raw of [undefined, null, 42, "x", []]) {
      const result = normalizeIntelligence(raw)

      expect(result).toMatchObject({
        overview: "",
        decisions: [],
        actionItems: [],
        risks: [],
        openQuestions: [],
        commitments: [],
        followUpDraft: "",
        timestampedQuotes: [],
        tags: [],
        items: [],
      })
      expect(result.languageMetadata.primaryLanguage).toBe("he")
      expect(result.version).toBeUndefined()
    }
  })

  it("reads legacy v1 and derives id'd items from the string arrays", () => {
    const result = normalizeIntelligence({
      overview: "Budget sync",
      decisions: ["Approve Q3 budget", "  ", 7],
      risks: ["Vendor delay"],
      openQuestions: [],
      commitments: ["דנה תשלח את המצגת"],
      actionItems: [{ id: "act_1", title: "Send deck", owner: "Dana" }, { owner: "no title" }],
      tags: ["finance", "not-a-tag"],
      languageMetadata: {
        primaryLanguage: "en",
        secondaryLanguages: ["he", "xx"],
        segmentLanguages: [],
        confidence: 0.9,
        mixedLanguage: false,
      },
    })

    expect(result.decisions).toEqual(["Approve Q3 budget"])
    expect(result.tags).toEqual(["finance"])
    expect(result.languageMetadata.secondaryLanguages).toEqual(["he"])
    expect(result.actionItems).toEqual([
      expect.objectContaining({
        id: "act_1",
        title: "Send deck",
        owner: "Dana",
        status: "open",
        priority: "normal",
        sourceQuote: "",
        sourceStartMs: 0,
        kind: "explicit",
      }),
    ])
    expect(result.items).toEqual([
      { id: summaryItemId("decision", "Approve Q3 budget"), kind: "decision", text: "Approve Q3 budget", refs: [] },
      { id: summaryItemId("risk", "Vendor delay"), kind: "risk", text: "Vendor delay", refs: [] },
      {
        id: summaryItemId("commitment", "דנה תשלח את המצגת"),
        kind: "commitment",
        text: "דנה תשלח את המצגת",
        refs: [],
      },
    ])
  })

  it("derives missing legacy arrays from V2 items and keeps V2 fields", () => {
    const result = normalizeIntelligence({
      version: 2,
      overview: "סיכום",
      title: "  סנכרון תקציב ",
      meetingType: "standup",
      topics: ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
      items: [
        { kind: "decision", text: "לאשר תקציב", refs: [{ segmentId: "seg_1", startMs: 1200 }, { segmentId: "", startMs: 5 }] },
        { id: "si_custom", kind: "open_question", text: "מי מוביל?", refs: [] },
        { kind: "section_item", sectionKey: "numbers", text: "1,200 ₪", refs: [] },
        { kind: "bogus", text: "dropped" },
      ],
      chapters: [
        { id: "ch_b", title: "Second", startMs: 60000, endMs: 120000, startSegmentId: "seg_9", bullets: [] },
        { id: "ch_a", title: "First", startMs: 0, endMs: 60000, startSegmentId: "seg_1", bullets: ["x"] },
        { title: "", startMs: 1 },
      ],
      sections: [{ key: "numbers", itemIds: ["si_x"] }, { text: "no key" }],
      generation: { provider: "gemini", model: "gemini-3.5-flash", languageCheck: "passed" },
    })

    expect(result.version).toBe(2)
    expect(result.title).toBe("סנכרון תקציב")
    expect(result.topics).toHaveLength(8)
    expect(result.decisions).toEqual(["לאשר תקציב"])
    expect(result.openQuestions).toEqual(["מי מוביל?"])
    expect(result.items?.map((item) => item.id)).toEqual([
      summaryItemId("decision", "לאשר תקציב"),
      "si_custom",
      summaryItemId("section_item", "1,200 ₪"),
    ])
    expect(result.items?.[0].refs).toEqual([{ segmentId: "seg_1", startMs: 1200 }])
    expect(result.items?.[2].sectionKey).toBe("numbers")
    expect(result.chapters?.map((chapter) => chapter.id)).toEqual(["ch_a", "ch_b"])
    expect(result.sections).toEqual([{ key: "numbers", itemIds: ["si_x"] }])
    expect(result.generation).toMatchObject({ provider: "gemini", languageCheck: "passed" })
  })

  it("keeps explicit legacy arrays when V2 items are also present", () => {
    const result = normalizeIntelligence({
      decisions: ["Legacy decision"],
      items: [{ kind: "decision", text: "Item decision", refs: [] }],
    })

    expect(result.decisions).toEqual(["Legacy decision"])
    expect(result.items).toHaveLength(1)
  })
})
