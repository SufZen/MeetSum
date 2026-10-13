import { describe, expect, it } from "vitest"

import { taskProperties } from "@/lib/integrations/hubspot/engagements"
import { renderHubspotNoteHtml } from "@/lib/integrations/hubspot/note-html"
import { buildNotionPage } from "@/lib/integrations/notion/blocks"
import { buildMeetingRecap, DEFAULT_RULE_CONTENT, dueEndOfDayIso, formatRecapDueDate, recapDueOn } from "@/lib/integrations/recap"
import { buildSlackRecapMessage } from "@/lib/integrations/slack/blocks"
import { testMeetingRecord } from "@/lib/integrations/testing/harness"
import type { MeetingRecord } from "@/lib/meetings/repository"

/**
 * M8 e2e fix #8: due dates are the date-only `dueOn` (derived in
 * Asia/Jerusalem from a timestamp when only `dueDate` exists), formatted per
 * locale, never a raw ISO string shifted a day; HubSpot tasks are due at the
 * local end of that day and fall back to the meeting end only without one.
 */

const TZ = "Asia/Jerusalem"

function meetingWith(item: Record<string, unknown>, language = "he"): MeetingRecord {
  return testMeetingRecord({
    id: "m_due",
    language,
    summary: { overview: "x", decisions: [], actionItems: [{ id: "a1", title: "לשלוח הצעה", status: "open", ...item }] },
  } as unknown as Partial<MeetingRecord> & { id: string })
}

describe("recap due dates", () => {
  it("derives the local date from a timestamp (2026-10-19T23:00Z is 2026-10-20 in Jerusalem)", () => {
    expect(recapDueOn({ dueDate: "2026-10-19T23:00:00.000Z" }, TZ)).toBe("2026-10-20")
    expect(recapDueOn({ dueOn: "2026-10-20", dueDate: "2026-10-19T23:00:00.000Z" }, TZ)).toBe("2026-10-20")
    expect(recapDueOn({ dueDate: "2026-10-20" }, TZ)).toBe("2026-10-20")
    expect(recapDueOn({}, TZ)).toBeUndefined()
  })

  it("formats per locale", () => {
    expect(formatRecapDueDate("2026-10-20", "he")).toBe("20.10.2026")
    expect(formatRecapDueDate("2026-10-20", "en")).toBe("Oct 20, 2026")
  })

  it("the recap carries the date-only due date, and Slack, Notion and the HubSpot note show it formatted", () => {
    const recap = buildMeetingRecap(meetingWith({ dueDate: "2026-10-19T23:00:00.000Z" }), { content: DEFAULT_RULE_CONTENT, links: {} })

    expect(recap.actionItems[0].dueDate).toBe("2026-10-20")

    const slack = JSON.stringify(buildSlackRecapMessage(recap, { locale: "he", timeZone: TZ }))
    const notion = JSON.stringify(buildNotionPage(recap, "he"))
    const note = renderHubspotNoteHtml(recap)

    for (const text of [slack, notion, note]) {
      expect(text).toContain("20.10.2026")
      expect(text).not.toContain("2026-10-19T23")
    }
  })

  it("HubSpot tasks are due at the local end of the due day; the meeting end only without a due date", () => {
    const recap = buildMeetingRecap(meetingWith({ dueOn: "2026-10-20" }), { content: DEFAULT_RULE_CONTENT, links: {} })

    expect(dueEndOfDayIso("2026-10-20", TZ)).toBe("2026-10-20T20:59:59.000Z")
    expect(taskProperties(recap.actionItems[0], recap, undefined).hs_timestamp).toBe("2026-10-20T20:59:59.000Z")

    const undated = buildMeetingRecap(meetingWith({}), { content: DEFAULT_RULE_CONTENT, links: {} })

    expect(taskProperties(undated.actionItems[0], undated, undefined).hs_timestamp).toBe(
      new Date(Date.parse(undated.startedAt) + (undated.durationMs ?? 0)).toISOString()
    )
  })
})
