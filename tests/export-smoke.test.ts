import { describe, expect, it } from "vitest"

import { renderMeetingMarkdown, renderMeetingPdf } from "@/lib/meetings/export"
import type { MeetingRecord } from "@/lib/meetings/repository"

const completedMeeting = {
  id: "export-test-001",
  title: "Export Smoke Test Meeting",
  startedAt: new Date("2026-05-28T10:00:00Z").toISOString(),
  source: "google_meet",
  language: "en",
  status: "completed",
  retention: "audio",
  participants: ["Alice", "Bob"],
  participantDetails: [
    { id: "p1", meetingId: "export-test-001", name: "Alice", email: "alice@test.com", role: "organizer", source: "calendar", attendanceStatus: "accepted", createdAt: "", updatedAt: "" },
    { id: "p2", meetingId: "export-test-001", name: "Bob", email: "bob@test.com", role: "attendee", source: "calendar", attendanceStatus: "accepted", createdAt: "", updatedAt: "" },
  ],
  summary: {
    overview: "Team discussed the Q3 roadmap and assigned key milestones.",
    decisions: ["Ship v2.0 by August 15", "Hire 2 new engineers"],
    actionItems: [
      { id: "a1", title: "Draft Q3 plan", owner: "Alice", status: "open" as const, dueDate: "2026-06-05", priority: "high" as const },
      { id: "a2", title: "Post job listings", owner: "Bob", status: "done" as const },
    ],
  },
  transcript: [
    { id: "t1", startMs: 0, endMs: 15000, speaker: "Alice", text: "Let's discuss the Q3 roadmap.", confidence: 0.95 },
    { id: "t2", startMs: 15000, endMs: 30000, speaker: "Bob", text: "I think we should target August for v2.0.", confidence: 0.88 },
  ],
  tags: ["technical" as const, "product" as const, "follow-up-needed" as const],
  aiRuns: [
    { id: "run1", meetingId: "export-test-001", provider: "gemini", task: "audio.transcribe", model: "gemini-3.5-flash", status: "completed" as const, latencyMs: 12500, startedAt: "", metadata: {} },
    { id: "run2", meetingId: "export-test-001", provider: "gemini", task: "summary.generate", model: "gemini-3.5-flash", status: "completed" as const, latencyMs: 3200, startedAt: "", metadata: {} },
  ],
  qualityWarnings: [],
  isFavorite: false,
} satisfies MeetingRecord

describe("markdown export", () => {
  it("includes all core sections", () => {
    const md = renderMeetingMarkdown(completedMeeting)

    expect(md).toContain("# Export Smoke Test Meeting")
    expect(md).toContain("## Overview")
    expect(md).toContain("Q3 roadmap")
    expect(md).toContain("## Decisions")
    expect(md).toContain("Ship v2.0 by August 15")
    expect(md).toContain("## Action Items")
    expect(md).toContain("Draft Q3 plan")
    expect(md).toContain("(Alice)")
    expect(md).toContain("## Transcript")
    expect(md).toContain("Alice: Let's discuss")
  })

  it("includes provider metadata", () => {
    const md = renderMeetingMarkdown(completedMeeting)

    expect(md).toContain("gemini")
    expect(md).toContain("gemini-3.5-flash")
  })

  it("marks completed action items with [x]", () => {
    const md = renderMeetingMarkdown(completedMeeting)

    expect(md).toContain("[x] Post job listings")
    expect(md).toContain("[ ] Draft Q3 plan")
  })

  it("does not include media URLs", () => {
    const meetingWithMedia = {
      ...completedMeeting,
      mediaUrl: "s3://private-bucket/recording.webm",
    }
    const md = renderMeetingMarkdown(meetingWithMedia)

    expect(md).not.toContain("s3://")
    expect(md).not.toContain("private-bucket")
  })

  it("includes participant names", () => {
    const md = renderMeetingMarkdown(completedMeeting)

    expect(md).toContain("Alice")
    expect(md).toContain("Bob")
  })
})

describe("pdf export", () => {
  it("produces a valid PDF buffer", () => {
    const pdf = renderMeetingPdf(completedMeeting)

    expect(pdf).toBeInstanceOf(Buffer)
    expect(pdf.length).toBeGreaterThan(100)
    // PDF magic bytes
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-")
  })

  it("contains meeting title in the PDF", () => {
    const pdf = renderMeetingPdf(completedMeeting)
    const text = pdf.toString("latin1")

    expect(text).toContain("Export Smoke Test Meeting")
  })

  it("contains provider metadata in the PDF", () => {
    const pdf = renderMeetingPdf(completedMeeting)
    const text = pdf.toString("latin1")

    expect(text).toContain("gemini")
  })
})
