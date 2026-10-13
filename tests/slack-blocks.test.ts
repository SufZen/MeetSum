import { describe, expect, it } from "vitest"

import { RLM } from "@/lib/integrations/bidi"
import type { MeetingRecap } from "@/lib/integrations/recap"
import { buildSlackActionItemMessage, buildSlackRecapMessage, escapeSlack, SLACK_MAX_BLOCKS } from "@/lib/integrations/slack/blocks"

/**
 * M8 A9 Block Kit recap: he/en snapshots, limits (header 150, sections
 * 3000, 50 blocks with "+N more", text 3000), escaping of `& < >`
 * (`<!channel>`, mentions, links) and RLM placement for Hebrew (every
 * line, bullet and the header; never inside URLs).
 */

const OPTIONS = { timeZone: "Asia/Jerusalem" }

function recap(overrides: Partial<MeetingRecap> = {}): MeetingRecap {
  return {
    meetingId: "m1",
    title: "פגישת מכירות רבעונית",
    language: "he",
    dir: "rtl",
    startedAt: "2026-10-01T07:00:00.000Z",
    durationMs: 45 * 60_000,
    participants: [{ name: "דנה" }, { name: "אבי" }, { name: "Client", email: "c@customer.com" }],
    overview: "סקרנו את הצנרת.\nהוחלט להתמקד בלקוחות אנטרפרייז.",
    actionItems: [
      { id: "a1", title: "לשלוח הצעת מחיר", owner: "דנה", dueDate: "2026-10-05", status: "open" },
      { id: "a2", title: "לתאם הדגמה", status: "open" },
    ],
    decisions: ["להשיק בנובמבר"],
    openQuestions: [],
    links: { meeting: "https://meetsum.example.com/he?meeting=m1" },
    visibility: "workspace",
    ...overrides,
  }
}

function texts(message: ReturnType<typeof buildSlackRecapMessage>): string[] {
  const result: string[] = []

  for (const block of message.blocks) {
    const text = (block.text as { text?: string } | undefined)?.text

    if (text) result.push(text)
    for (const element of (block.elements as { text?: string | { text: string } }[] | undefined) ?? []) {
      if (typeof element.text === "string") result.push(element.text)
    }
  }
  return result
}

describe("buildSlackRecapMessage", () => {
  it("renders a Hebrew recap (snapshot) with RLM on every line and none inside URLs", () => {
    const message = buildSlackRecapMessage(recap(), { ...OPTIONS, locale: "he" })

    expect(message).toMatchSnapshot()
    for (const text of texts(message)) {
      for (const line of text.split("\n")) expect(line.startsWith(RLM), JSON.stringify(line)).toBe(true)
    }
    expect(texts(message).join("\n")).toContain("משימות")
    const button = message.blocks.at(-1) as { type: string; elements: { url: string; text: { text: string } }[] }

    expect(button.type).toBe("actions")
    expect(button.elements[0]).toMatchObject({ url: "https://meetsum.example.com/he?meeting=m1", text: { text: "פתיחה ב-MeetSum" } })
    expect(button.elements[0].url).not.toContain(RLM)
    expect(message.text).toContain("https://meetsum.example.com/he?meeting=m1")
    expect(message.text).not.toContain(`${RLM}https://`)
  })

  it("renders an English recap (snapshot) without RLM", () => {
    const message = buildSlackRecapMessage(
      recap({ title: "Quarterly sales sync", language: "en", dir: "ltr", overview: "We reviewed the pipeline.", decisions: ["Launch in November"] }),
      { ...OPTIONS, locale: "en" }
    )

    expect(message).toMatchSnapshot()
    expect(JSON.stringify(message)).not.toContain(RLM)
    expect(texts(message).join("\n")).toContain("*Action items*")
  })

  it("escapes channel pings, mentions and link markup from content", () => {
    const message = buildSlackRecapMessage(
      recap({
        title: "<!channel> hi",
        overview: "Ping <!here> and <@U123> or <https://evil.test|click> & more",
        actionItems: [{ id: "a", title: "<!everyone>", owner: "<@U9>", status: "open" }],
        decisions: ["<script>"],
      }),
      { ...OPTIONS, locale: "en" }
    )
    const all = JSON.stringify(message)

    expect(all).not.toMatch(/<!channel>|<!here>|<@U123>|<https:\/\/evil|<!everyone>|<@U9>|<script>/)
    expect(all).toContain("&lt;!channel&gt;")
    expect(escapeSlack("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d")
  })

  it("keeps every limit: header 150, sections 3000, ≤ 50 blocks with +N more, text 3000", () => {
    const long = "מילה ".repeat(5000)
    const message = buildSlackRecapMessage(
      recap({
        title: "כותרת ארוכה ".repeat(40),
        overview: long,
        actionItems: Array.from({ length: 400 }, (_, index) => ({
          id: `a${index}`,
          title: `משימה ${index} ${"פרטים ".repeat(30)}`,
          status: "open" as const,
        })),
        decisions: Array.from({ length: 800 }, (_, index) => `החלטה ${index} ${"נימוק ".repeat(20)}`),
      }),
      { ...OPTIONS, locale: "he" }
    )

    expect(message.blocks.length).toBeLessThanOrEqual(SLACK_MAX_BLOCKS)
    expect(((message.blocks[0].text as { text: string }).text).length).toBeLessThanOrEqual(150)
    for (const text of texts(message)) expect(text.length).toBeLessThanOrEqual(3000)
    expect(message.text.length).toBeLessThanOrEqual(3000)
    expect(texts(message).some((text) => /\+.*\d.*ועוד/.test(text))).toBe(true)
    expect(message.blocks.at(-1)?.type).toBe("actions")
  })

  it("omits the button for a relative app link and adds the share button when present", () => {
    const relative = buildSlackRecapMessage(recap({ links: { meeting: "/he?meeting=m1" } }), { ...OPTIONS, locale: "he" })

    expect(relative.blocks.some((block) => block.type === "actions")).toBe(false)

    const shared = buildSlackRecapMessage(
      recap({ links: { meeting: "https://a.test/he?meeting=m1", share: "https://a.test/share/tok" } }),
      { ...OPTIONS, locale: "en" }
    )
    const actions = shared.blocks.at(-1) as { elements: unknown[] }

    expect(actions.elements).toHaveLength(2)
  })

  it("builds a one-item message for action_item.created", () => {
    const value = recap()
    const message = buildSlackActionItemMessage(value, value.actionItems[0], { ...OPTIONS, locale: "he" })

    expect(texts(message)[0]).toContain("לשלוח הצעת מחיר")
    expect(texts(message)[0].split("\n").every((line) => line.startsWith(RLM))).toBe(true)
  })
})
