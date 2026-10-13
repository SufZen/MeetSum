import { describe, expect, it } from "vitest"

import {
  answerCopyText,
  citedCitations,
  segmentAnswer,
  stripCitationMarkers,
  type AnswerBlock,
} from "@/lib/client/answer-segments"
import type { AskCitation } from "@/lib/ask/types"

const citation = (n: number, alias: string, extra: Partial<AskCitation> = {}): AskCitation => ({
  n,
  alias,
  meetingId: "m1",
  meetingTitle: "ישיבת תקציב",
  kind: "transcript",
  quote: "התקציב עלה",
  segmentId: `seg-${alias}`,
  startMs: 1000 * n,
  ...extra,
})

const s1 = citation(1, "s1")
const s4 = citation(2, "s4")
const a2 = citation(3, "a2", { kind: "item" })

describe("segmentAnswer", () => {
  it("turns known markers into numbered chips", () => {
    const blocks = segmentAnswer("התקציב עלה ב-10% [s1]. ההחלטה התקבלה [s4].", [s1, s4])

    expect(blocks).toEqual<AnswerBlock[]>([
      {
        type: "paragraph",
        inlines: [
          { type: "text", text: "התקציב עלה ב-10% " },
          { type: "cite", citation: s1 },
          { type: "text", text: ". ההחלטה התקבלה " },
          { type: "cite", citation: s4 },
          { type: "text", text: "." },
        ],
      },
    ])
    expect(citedCitations(blocks).map((item) => item.n)).toEqual([1, 2])
  })

  it("keeps unknown aliases as plain text", () => {
    const blocks = segmentAnswer("Claim [s99] and [a7].", [s1])

    expect(blocks).toEqual([{ type: "paragraph", inlines: [{ type: "text", text: "Claim [s99] and [a7]." }] }])
    expect(citedCitations(blocks)).toEqual([])
  })

  it("splits grouped markers and keeps an unknown member as text", () => {
    const [block] = segmentAnswer("Both [s1, s4] and [s1; s99]", [s1, s4])

    expect(block).toEqual({
      type: "paragraph",
      inlines: [
        { type: "text", text: "Both " },
        { type: "cite", citation: s1 },
        { type: "cite", citation: s4 },
        { type: "text", text: " and " },
        { type: "cite", citation: s1 },
        { type: "text", text: "[s99]" },
      ],
    })
  })

  it("collapses a repeated adjacent marker into one chip", () => {
    const [block] = segmentAnswer("Once [s1][s1] [S1]", [s1])

    expect(block).toEqual({
      type: "paragraph",
      inlines: [
        { type: "text", text: "Once " },
        { type: "cite", citation: s1 },
      ],
    })
  })

  it("parses paragraphs, bullets and bold, nothing else", () => {
    const text = "**סיכום:** שתי החלטות [a2]\n\n- ראשונה [s1]\n* שנייה [s4]\n\n![x](https://evil) <b>hi</b>"
    const blocks = segmentAnswer(text, [s1, s4, a2])

    expect(blocks).toEqual<AnswerBlock[]>([
      {
        type: "paragraph",
        inlines: [
          { type: "text", text: "סיכום:", bold: true },
          { type: "text", text: " שתי החלטות " },
          { type: "cite", citation: a2 },
        ],
      },
      {
        type: "list",
        items: [
          [
            { type: "text", text: "ראשונה " },
            { type: "cite", citation: s1 },
          ],
          [
            { type: "text", text: "שנייה " },
            { type: "cite", citation: s4 },
          ],
        ],
      },
      { type: "paragraph", inlines: [{ type: "text", text: "![x](https://evil) <b>hi</b>" }] },
    ])
  })

  it("keeps an unmatched ** literal", () => {
    expect(segmentAnswer("a ** b", [])).toEqual([{ type: "paragraph", inlines: [{ type: "text", text: "a ** b" }] }])
  })

  it("joins wrapped lines into one paragraph", () => {
    expect(segmentAnswer("line one\nline two", [])).toEqual([
      { type: "paragraph", inlines: [{ type: "text", text: "line one line two" }] },
    ])
  })
})

describe("stripCitationMarkers", () => {
  it("removes complete and still-arriving markers", () => {
    expect(stripCitationMarkers("התקציב עלה [s1]. ועוד [s")).toBe("התקציב עלה. ועוד ")
  })
})

describe("answerCopyText", () => {
  it("numbers markers and lists the sources with links", () => {
    const text = answerCopyText("Claim [s1]. Other [s4, s99].", [s1, s4, { ...a2, unavailable: true }], (item) =>
      `/he?meeting=${item.meetingId}&t=${Math.floor((item.startMs ?? 0) / 1000)}`
    )

    expect(text).toBe("Claim [1]. Other [2].\n\n[1] ישיבת תקציב /he?meeting=m1&t=1\n[2] ישיבת תקציב /he?meeting=m1&t=2")
  })
})
