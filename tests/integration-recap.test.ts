import { describe, expect, it } from "vitest"

import type { RuleContent } from "@/lib/integrations/core/types"
import { DEFAULT_RULE_CONTENT, buildMeetingRecap } from "@/lib/integrations/recap"
import type { MeetingRecord } from "@/lib/meetings/repository"

/** M8 Step 0: the provider-neutral recap (docs/parity/m8.md, "Shared contracts"). */

function meeting(overrides: Partial<MeetingRecord> = {}): MeetingRecord {
  return {
    id: "m_he",
    title: "סקירת תקציב Q3",
    source: "upload",
    language: "he",
    status: "completed",
    retention: "audio",
    startedAt: "2026-10-12T08:00:00.000Z",
    durationMs: 1_800_000,
    participants: ["Dana", "Avi"],
    participantDetails: [
      { id: "p1", meetingId: "m_he", name: "דנה כהן", email: "Dana@Example.com", role: "organizer", source: "calendar", attendanceStatus: "accepted", createdAt: "", updatedAt: "" },
      { id: "p2", meetingId: "m_he", name: "Dana duplicate", email: "dana@example.com", role: "attendee", source: "calendar", attendanceStatus: "accepted", createdAt: "", updatedAt: "" },
      { id: "p3", meetingId: "m_he", name: "אבי", role: "speaker", source: "transcript", attendanceStatus: "unknown", createdAt: "", updatedAt: "" },
    ],
    visibility: "workspace",
    summary: {
      overview: "  סוכם על תקציב.  ",
      decisions: ["Legacy decision"],
      actionItems: [
        { id: "ai_1", title: "לשלוח דוח", ownerText: "דנה", status: "open", dueOn: "2026-10-20", priority: "high" },
        { id: "ai_2", title: "Close books", owner: "Avi", status: "done", dueDate: "2026-10-01" },
      ],
    },
    transcript: [
      { id: "s1", speaker: "דנה", startMs: 0, endMs: 1000, text: "שלום", language: "he" },
      { id: "s2", speaker: "Avi", startMs: 1000, endMs: 2000, text: "Hi" },
    ],
    ...overrides,
  }
}

const links = { meeting: "https://app.example/he?meeting=m_he", share: "https://app.example/share/tok" }

describe("buildMeetingRecap", () => {
  it("builds the default recap: overview, action items, decisions; no transcript", () => {
    const recap = buildMeetingRecap(meeting(), { content: DEFAULT_RULE_CONTENT, links })

    expect(recap).toMatchObject({
      meetingId: "m_he",
      title: "סקירת תקציב Q3",
      language: "he",
      dir: "rtl",
      durationMs: 1_800_000,
      overview: "סוכם על תקציב.",
      decisions: ["Legacy decision"],
      openQuestions: [],
      links: { meeting: links.meeting },
      visibility: "workspace",
    })
    expect(recap.participants).toEqual([{ name: "דנה כהן", email: "dana@example.com" }, { name: "אבי" }])
    expect(recap.actionItems).toEqual([
      { id: "ai_1", title: "לשלוח דוח", owner: "דנה", dueDate: "2026-10-20", priority: "high", status: "open" },
      { id: "ai_2", title: "Close books", owner: "Avi", dueDate: "2026-10-01", status: "done" },
    ])
    expect(recap.transcript).toBeUndefined()
  })

  it("honours every content toggle and the link mode", () => {
    const none: RuleContent = { overview: false, actionItems: false, decisions: false, openQuestions: false, transcript: false, link: "none" }
    const recap = buildMeetingRecap(meeting(), { content: none, links })

    expect(recap.overview).toBeUndefined()
    expect(recap.actionItems).toEqual([])
    expect(recap.decisions).toEqual([])
    expect(recap.links).toEqual({})

    const shared = buildMeetingRecap(meeting(), { content: { ...none, link: "existing_share", transcript: true }, links })

    expect(shared.links).toEqual(links)
    expect(shared.transcript).toEqual([
      { startMs: 0, speaker: "דנה", text: "שלום", language: "he" },
      { startMs: 1000, speaker: "Avi", text: "Hi" },
    ])
    // existing_share without a share keeps only the app link.
    expect(buildMeetingRecap(meeting(), { content: { ...none, link: "existing_share" }, links: { meeting: links.meeting } }).links).toEqual({
      meeting: links.meeting,
    })
  })

  it("uses M5 IntelligenceV2 items for decisions and open questions when present", () => {
    const withV2 = meeting({
      intelligence: {
        overview: "x",
        decisions: ["legacy v1 decision"],
        actionItems: [],
        risks: [],
        openQuestions: ["legacy question"],
        commitments: [],
        followUpDraft: "",
        timestampedQuotes: [],
        tags: [],
        languageMetadata: { primaryLanguage: "he", secondaryLanguages: [], segmentLanguages: [], confidence: 1, mixedLanguage: false },
        version: 2,
        items: [
          { id: "si_1", kind: "decision", text: "החלטה מ-V2", refs: [] },
          { id: "si_2", kind: "open_question", text: "שאלה פתוחה", refs: [] },
          { id: "si_3", kind: "risk", text: "סיכון", refs: [] },
        ],
        chapters: [{ id: "c1", title: "פתיחה", summary: "", startMs: 0, endMs: 10, startSegmentId: "s1", bullets: [] }],
      },
    })
    const recap = buildMeetingRecap(withV2, { content: { ...DEFAULT_RULE_CONTENT, openQuestions: true }, links })

    expect(recap.decisions).toEqual(["החלטה מ-V2"])
    expect(recap.openQuestions).toEqual(["שאלה פתוחה"])
    expect(recap.chapters).toEqual([{ title: "פתיחה", startMs: 0 }])
  })

  it("is LTR for English, falls back to plain participants and treats unknown visibility as private", () => {
    const recap = buildMeetingRecap(
      meeting({ language: "en", participantDetails: undefined, visibility: undefined }),
      { content: DEFAULT_RULE_CONTENT, links: {} }
    )

    expect(recap.dir).toBe("ltr")
    expect(recap.participants).toEqual([{ name: "Dana" }, { name: "Avi" }])
    expect(recap.visibility).toBe("private")
    expect(recap.links).toEqual({})
  })
})
