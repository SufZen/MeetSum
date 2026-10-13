import { describe, expect, it } from "vitest"

import { buildGoogleDocRequests, type GoogleDocRequest } from "@/lib/integrations/google-docs/builder"
import type { MeetingRecap } from "@/lib/integrations/recap"

/**
 * M8 C2: one insertText at index 1, then paragraph styles and bullets whose
 * ranges are UTF-16 code-unit exact (Hebrew, emoji), RTL direction and START
 * alignment on Hebrew paragraphs only.
 */

function recap(overrides: Partial<MeetingRecap> = {}): MeetingRecap {
  return {
    meetingId: "meet_1",
    title: "סנכרון 🚀 שבועי",
    language: "he",
    dir: "rtl",
    startedAt: "2026-10-12T07:30:00.000Z",
    participants: [{ name: "דנה", email: "dana@example.com" }, { name: "Alex" }],
    overview: "סיכום 😀 קצר.\n\nWe agreed on the plan.",
    actionItems: [
      { id: "act_1", title: "לשלוח תוכנית", owner: "דנה", dueDate: "2026-10-20", status: "open" },
      { id: "act_2", title: "Ship 🚢 v2", status: "done" },
    ],
    decisions: ["משחררים בספטמבר", "Budget approved"],
    openQuestions: [],
    transcript: [
      { startMs: 12_000, speaker: "דנה", text: "בואו נתחיל 👋", language: "he" },
      { startMs: 75_000, speaker: "Alex", text: "Sounds good", language: "en" },
    ],
    links: { meeting: "https://meetsum.example.com/he?meeting=meet_1" },
    visibility: "workspace",
    ...overrides,
  }
}

type Range = { startIndex: number; endIndex: number }

function inserted(requests: GoogleDocRequest[]): string {
  const insert = requests[0] as { insertText: { location: { index: number }; text: string } }

  expect(insert.insertText.location.index).toBe(1)

  return insert.insertText.text
}

/** Document text at a range (index 1 = first character of the inserted text). */
function at(text: string, range: Range): string {
  return text.slice(range.startIndex - 1, range.endIndex - 1)
}

function styles(requests: GoogleDocRequest[]) {
  return requests
    .filter((request): request is Extract<GoogleDocRequest, { updateParagraphStyle: unknown }> => "updateParagraphStyle" in request)
    .map((request) => request.updateParagraphStyle)
}

describe("buildGoogleDocRequests", () => {
  it("inserts all text once at index 1 and styles every paragraph with exact UTF-16 ranges", () => {
    const { title, requests } = buildGoogleDocRequests(recap(), "he")
    const text = inserted(requests)
    const paragraphs = styles(requests)

    expect(title).toBe("סנכרון 🚀 שבועי")
    expect(requests.filter((request) => "insertText" in request)).toHaveLength(1)
    // Ranges tile the text exactly, newline included.
    expect(paragraphs[0].range.startIndex).toBe(1)
    for (let index = 1; index < paragraphs.length; index += 1) {
      expect(paragraphs[index].range.startIndex).toBe(paragraphs[index - 1].range.endIndex)
    }
    expect(paragraphs[paragraphs.length - 1].range.endIndex).toBe(1 + text.length)
    for (const paragraph of paragraphs) {
      const slice = at(text, paragraph.range)

      expect(slice.endsWith("\n")).toBe(true)
      expect(slice.slice(0, -1)).not.toContain("\n")
    }

    // Emoji are 2 code units: the paragraph after an emoji paragraph still lines up.
    const emojiParagraph = paragraphs.find((paragraph) => at(text, paragraph.range).includes("😀"))!

    expect(at(text, emojiParagraph.range)).toBe("סיכום 😀 קצר.\n")
  })

  it("puts RIGHT_TO_LEFT + START on Hebrew paragraphs only, following each segment's language", () => {
    const { requests } = buildGoogleDocRequests(recap(), "he")
    const text = inserted(requests)
    const byText = (needle: string) => styles(requests).find((paragraph) => at(text, paragraph.range).includes(needle))!

    expect(byText("בואו נתחיל").paragraphStyle).toMatchObject({ direction: "RIGHT_TO_LEFT", alignment: "START" })
    expect(byText("בואו נתחיל").fields).toBe("namedStyleType,direction,alignment")
    expect(byText("Sounds good").paragraphStyle).not.toHaveProperty("direction")
    expect(byText("Sounds good").fields).toBe("namedStyleType")
    expect(byText("סנכרון").paragraphStyle).toMatchObject({ namedStyleType: "HEADING_1", direction: "RIGHT_TO_LEFT" })
    expect(byText("סקירה").paragraphStyle.namedStyleType).toBe("HEADING_2")

    const english = buildGoogleDocRequests(recap({ language: "en", dir: "ltr", transcript: [] }), "en")

    expect(styles(english.requests).every((paragraph) => !("direction" in paragraph.paragraphStyle))).toBe(true)
  })

  it("isolates timecodes and dates as LTR inside Hebrew text", () => {
    const text = inserted(buildGoogleDocRequests(recap(), "he").requests)

    expect(text).toContain("⁦00:12⁩")
    expect(text).toContain("⁦2026-10-20⁩")
    expect(text).toContain("⁦dana@example.com⁩")
  })

  it("adds checkbox bullets for action items and disc bullets for decisions", () => {
    const { requests } = buildGoogleDocRequests(recap(), "he")
    const text = inserted(requests)
    const bullets = requests
      .filter((request): request is Extract<GoogleDocRequest, { createParagraphBullets: unknown }> => "createParagraphBullets" in request)
      .map((request) => request.createParagraphBullets)

    expect(bullets.map((bullet) => bullet.bulletPreset)).toEqual(["BULLET_CHECKBOX", "BULLET_DISC_CIRCLE_SQUARE"])
    expect(at(text, bullets[0].range)).toContain("לשלוח תוכנית")
    expect(at(text, bullets[0].range)).toContain("Ship 🚢 v2")
    expect(at(text, bullets[1].range)).toContain("משחררים בספטמבר")
    expect(at(text, bullets[1].range)).toContain("Budget approved")
  })

  it("links back to MeetSum and strikes done items, with exact ranges", () => {
    const { requests } = buildGoogleDocRequests(recap(), "he")
    const text = inserted(requests)
    const textStyles = requests
      .filter((request): request is Extract<GoogleDocRequest, { updateTextStyle: unknown }> => "updateTextStyle" in request)
      .map((request) => request.updateTextStyle)
    const link = textStyles.find((style) => style.textStyle.link)!
    const strike = textStyles.find((style) => style.textStyle.strikethrough)!

    expect(link.textStyle.link).toEqual({ url: "https://meetsum.example.com/he?meeting=meet_1" })
    expect(at(text, link.range)).toBe("פתיחה ב-MeetSum")
    expect(at(text, strike.range)).toBe("Ship 🚢 v2")
  })

  it("omits the transcript unless the recap carries one, and uses English headings for en", () => {
    const text = inserted(buildGoogleDocRequests(recap({ transcript: undefined, language: "en", dir: "ltr" }), "en").requests)

    expect(text).toContain("Overview\n")
    expect(text).not.toContain("Transcript")
  })
})
