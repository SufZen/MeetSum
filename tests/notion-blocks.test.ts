import { describe, expect, it } from "vitest"

import { RLM } from "@/lib/integrations/bidi"
import {
  batchNotionChildren,
  buildNotionPage,
  NOTION_MAX_CHILDREN_PER_REQUEST,
  NOTION_MAX_RICH_TEXT_ITEMS,
  NOTION_MAX_TEXT_LENGTH,
  type NotionBlock,
} from "@/lib/integrations/notion/blocks"
import type { MeetingRecap } from "@/lib/integrations/recap"

/**
 * M8 C1: Notion pages within the API limits (rich_text ≤ 2000, ≤ 100 items
 * per block, ≤ 100 children per request), Hebrew lines that lay out RTL in
 * their original order, localized headings, a capped transcript.
 */

function recap(overrides: Partial<MeetingRecap> = {}): MeetingRecap {
  return {
    meetingId: "meet_1",
    title: "סנכרון שבועי",
    language: "he",
    dir: "rtl",
    startedAt: "2026-10-12T07:30:00.000Z",
    participants: [{ name: "דנה", email: "dana@example.com" }],
    overview: "שורה ראשונה של הסיכום.\n\nפסקה שנייה על MeetSum.",
    actionItems: [
      { id: "act_1", title: "לשלוח תוכנית", owner: "דנה", dueDate: "2026-10-20", status: "open" },
      { id: "act_2", title: "Ship v2", status: "done" },
    ],
    decisions: ["משחררים בספטמבר", "Budget approved"],
    openQuestions: [],
    links: { meeting: "https://meetsum.example.com/he?meeting=meet_1" },
    visibility: "workspace",
    ...overrides,
  }
}

type RichText = { type: string; text: { content: string; link?: { url: string } | null } }

function richTextOf(block: NotionBlock): RichText[] {
  const body = block[block.type] as { rich_text?: RichText[] } | undefined

  return body?.rich_text ?? []
}

function textOf(block: NotionBlock): string {
  return richTextOf(block)
    .map((item) => item.text.content)
    .join("")
}

function allBlocks(children: NotionBlock[]): NotionBlock[] {
  return children.flatMap((block) => {
    const nested = (block[block.type] as { children?: NotionBlock[] } | undefined)?.children ?? []

    return [block, ...allBlocks(nested)]
  })
}

describe("buildNotionPage", () => {
  it("never exceeds 2000 characters per rich_text or 100 rich_text items per block", () => {
    const longOverview = "מילה ".repeat(60_000) // 300k characters
    const { children } = buildNotionPage(
      recap({
        overview: longOverview,
        transcript: [{ startMs: 0, speaker: "דנה", text: "x".repeat(9_000), language: "he" }],
      }),
      "he"
    )

    for (const block of allBlocks(children)) {
      const items = richTextOf(block)

      expect(items.length, block.type).toBeLessThanOrEqual(NOTION_MAX_RICH_TEXT_ITEMS)
      for (const item of items) expect(item.text.content.length).toBeLessThanOrEqual(NOTION_MAX_TEXT_LENGTH)
    }

    // Nothing is lost: the overview round-trips (apart from the RLM prefixes).
    const overviewText = children
      .filter((block) => block.type === "paragraph")
      .map(textOf)
      .join("")
      .replaceAll(RLM, "")
      .replace(/\s+/g, "")

    expect(overviewText).toContain(longOverview.replace(/\s+/g, ""))
  })

  it("caps a 5000-segment transcript and appends a truncation callout", () => {
    const transcript = Array.from({ length: 5000 }, (_, index) => ({
      startMs: index * 1000,
      speaker: "Alex",
      text: `segment ${index}`,
    }))
    const { children } = buildNotionPage(recap({ language: "en", dir: "ltr", transcript }), "en", {
      maxTranscriptBlocks: 900,
    })
    const segments = children.filter((block) => block.type === "paragraph" && /segment \d+/.test(textOf(block)))
    const callout = children[children.length - 1]

    expect(segments).toHaveLength(900)
    expect(callout.type).toBe("callout")
    expect(textOf(callout)).toContain("4100")
  })

  it("batches children by at most 100 per request", () => {
    const transcript = Array.from({ length: 450 }, (_, index) => ({ startMs: index, speaker: "A", text: `t${index}` }))
    const { children } = buildNotionPage(recap({ transcript }), "he")
    const batches = batchNotionChildren(children)

    expect(batches.length).toBe(Math.ceil(children.length / NOTION_MAX_CHILDREN_PER_REQUEST))
    expect(batches.every((batch) => batch.length <= NOTION_MAX_CHILDREN_PER_REQUEST)).toBe(true)
    expect(batches.flat()).toEqual(children)
  })

  it("keeps Hebrew line order and starts every Hebrew line with Hebrew or RLM", () => {
    const transcript = [
      { startMs: 12_000, speaker: "דנה", text: "בואו נתחיל", language: "he" },
      { startMs: 75_000, speaker: "Alex", text: "OK, let's go", language: "he" },
      { startMs: 80_000, speaker: "Alex", text: "English segment", language: "en" },
    ]
    const { children } = buildNotionPage(recap({ transcript }), "he")
    const texts = children.map(textOf).filter(Boolean)
    const start = texts.findIndex((text) => text.includes("בואו נתחיל"))

    // Original order is preserved.
    expect(texts[start]).toContain("דנה")
    expect(texts[start + 1]).toContain("OK, let's go")
    expect(texts[start + 2]).toContain("English segment")

    // RTL segments: first character is RTL or RLM; the timecode is at the end.
    expect(texts[start]).toMatch(new RegExp(`^(${RLM}|[\\u0590-\\u05FF])`))
    expect(texts[start + 1].startsWith(RLM)).toBe(true)
    expect(texts[start]).toMatch(/00:12‎?$/)
    // An English segment in a Hebrew meeting is left LTR.
    expect(texts[start + 2].startsWith(RLM)).toBe(false)

    // Every line of every Hebrew block is RTL-safe.
    for (const block of children.filter((candidate) => candidate.type !== "divider")) {
      const text = textOf(block)

      if (!text || block.type === "callout" || text.includes("English segment")) continue
      for (const line of text.split("\n")) {
        expect(line, line).toMatch(new RegExp(`^(${RLM}|[\\u0590-\\u05FF])`))
      }
    }
  })

  it("localizes headings and renders action items as to_do and decisions as bullets", () => {
    const he = buildNotionPage(recap(), "he").children
    const en = buildNotionPage(recap({ language: "en", dir: "ltr" }), "en").children
    const headings = (blocks: NotionBlock[]) => blocks.filter((block) => block.type === "heading_2").map(textOf)

    expect(headings(he).map((text) => text.replaceAll(RLM, ""))).toEqual(["סקירה", "משימות", "החלטות"])
    expect(headings(en)).toEqual(["Overview", "Action Items", "Decisions"])

    const todos = he.filter((block) => block.type === "to_do")

    expect(todos).toHaveLength(2)
    expect((todos[1].to_do as { checked: boolean }).checked).toBe(true)
    expect(textOf(todos[0])).toContain("דנה")
    expect(he.filter((block) => block.type === "bulleted_list_item")).toHaveLength(2)
    expect(he.filter((block) => block.type === "code")).toHaveLength(0)
  })

  it("links back to MeetSum and never emits markup", () => {
    const { children } = buildNotionPage(recap({ overview: "<b>bold</b> **x**" }), "he")
    const link = children.flatMap(richTextOf).find((item) => item.text.link)

    expect(link?.text.link?.url).toBe("https://meetsum.example.com/he?meeting=meet_1")
    expect(children.map(textOf).join("\n")).toContain("<b>bold</b> **x**")
  })
})
