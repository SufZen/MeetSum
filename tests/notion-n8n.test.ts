import { describe, expect, it } from "vitest"

import { buildNotionBlocks, buildNotionProperties } from "@/lib/integrations/notion"
import type { MeetingRecord } from "@/lib/meetings/repository"

const mockMeeting = {
  id: "meeting_notion_test",
  title: "Q4 Planning Meeting",
  startedAt: "2026-05-28T10:00:00Z",
  endedAt: "2026-05-28T11:30:00Z",
  status: "completed",
  source: "google_meet",
  language: "en",
  retention: "audio" as const,
  participants: ["Alice", "Bob", "Charlie"],
  participantDetails: [
    { id: "p1", meetingId: "meeting_notion_test", name: "Alice Chen", email: "alice@example.com", role: "organizer" as const, source: "calendar" as const, attendanceStatus: "accepted" as const, createdAt: "2026-05-28T10:00:00Z", updatedAt: "2026-05-28T10:00:00Z" },
    { id: "p2", meetingId: "meeting_notion_test", name: "Bob Smith", email: "bob@example.com", role: "attendee" as const, source: "calendar" as const, attendanceStatus: "accepted" as const, createdAt: "2026-05-28T10:00:00Z", updatedAt: "2026-05-28T10:00:00Z" },
  ],
  summary: {
    overview: "Discussed Q4 roadmap priorities and budget allocation.",
    decisions: [
      "Focus on mobile-first strategy",
      "Hire 2 senior engineers by October",
    ],
    actionItems: [
      { id: "ai_1", title: "Draft mobile roadmap", status: "open" as const, owner: "Alice" },
      { id: "ai_2", title: "Post job listings", status: "done" as const, owner: "Bob", dueDate: "2026-06-15" },
    ],
  },
  transcript: [
    { id: "s1", speaker: "Alice", text: "Let's review the Q4 priorities.", startMs: 0, endMs: 3000 },
    { id: "s2", speaker: "Bob", text: "I think mobile should be first.", startMs: 3000, endMs: 6000 },
  ],
  tags: ["technical" as const],
  isFavorite: false,
} as MeetingRecord

describe("notion block builder", () => {
  it("generates blocks for a complete meeting", () => {
    const blocks = buildNotionBlocks(mockMeeting)

    expect(blocks.length).toBeGreaterThan(5)
    expect(blocks.every((b) => b.object === "block")).toBe(true)
  })

  it("includes overview heading and content", () => {
    const blocks = buildNotionBlocks(mockMeeting)

    const overviewHeading = blocks.find(
      (b) =>
        b.type === "heading_2" &&
        (b.heading_2 as { rich_text: Array<{ text: { content: string } }> })
          .rich_text[0]?.text.content === "Overview"
    )

    expect(overviewHeading).toBeDefined()
  })

  it("creates bulleted list items for decisions", () => {
    const blocks = buildNotionBlocks(mockMeeting)
    const bulletItems = blocks.filter((b) => b.type === "bulleted_list_item")

    expect(bulletItems).toHaveLength(2)
  })

  it("creates to-do blocks for action items", () => {
    const blocks = buildNotionBlocks(mockMeeting)
    const todos = blocks.filter((b) => b.type === "to_do")

    expect(todos).toHaveLength(2)

    const first = todos[0].to_do as { checked: boolean }
    expect(first.checked).toBe(false)

    const second = todos[1].to_do as { checked: boolean }
    expect(second.checked).toBe(true)
  })

  it("includes transcript as code block", () => {
    const blocks = buildNotionBlocks(mockMeeting)
    const codeBlocks = blocks.filter((b) => b.type === "code")

    expect(codeBlocks).toHaveLength(1)
    const code = codeBlocks[0].code as { rich_text: Array<{ text: { content: string } }> }
    expect(code.rich_text[0].text.content).toContain("Alice")
    expect(code.rich_text[0].text.content).toContain("Bob")
  })

  it("includes metadata callout", () => {
    const blocks = buildNotionBlocks(mockMeeting)
    const callouts = blocks.filter((b) => b.type === "callout")

    expect(callouts.length).toBeGreaterThan(0)
    const last = callouts[callouts.length - 1].callout as {
      rich_text: Array<{ text: { content: string } }>
    }
    expect(last.rich_text[0].text.content).toContain("MeetSum")
  })

  it("handles meeting without summary", () => {
    const noSummary = { ...mockMeeting, summary: undefined }
    const blocks = buildNotionBlocks(noSummary)

    expect(blocks.length).toBeGreaterThan(0)
    const paragraphs = blocks.filter((b) => b.type === "paragraph")
    expect(paragraphs.length).toBeGreaterThan(0)
  })

  it("handles meeting without transcript", () => {
    const noTranscript = { ...mockMeeting, transcript: undefined }
    const blocks = buildNotionBlocks(noTranscript)

    const codeBlocks = blocks.filter((b) => b.type === "code")
    expect(codeBlocks).toHaveLength(0)
  })
})

describe("notion properties builder", () => {
  it("builds correct page properties", () => {
    const props = buildNotionProperties(mockMeeting)

    expect(props.Name.title[0].text.content).toBe("Q4 Planning Meeting")
    expect(props.Date.date.start).toBe("2026-05-28T10:00:00Z")
    expect(props.Status.select.name).toBe("completed")
    expect(props.Source.select.name).toBe("google_meet")
    expect(props.Language.rich_text[0].text.content).toBe("en")
    expect(props.Participants.rich_text[0].text.content).toContain("Alice")
  })

  it("uses participantDetails names when available", () => {
    const props = buildNotionProperties(mockMeeting)

    expect(props.Participants.rich_text[0].text.content).toBe(
      "Alice Chen, Bob Smith"
    )
  })
})

describe("n8n template validation", () => {
  const templates = [
    "meeting-completed-slack",
    "action-item-todoist",
    "weekly-digest-email",
  ]

  for (const name of templates) {
    it(`${name}.json is valid JSON with required fields`, async () => {
      const fs = await import("fs")
      const path = await import("path")
      const filePath = path.join(
        process.cwd(),
        "docs",
        "n8n-templates",
        `${name}.json`
      )
      const content = fs.readFileSync(filePath, "utf-8")
      const workflow = JSON.parse(content)

      expect(workflow.name).toBeTruthy()
      expect(workflow.nodes).toBeInstanceOf(Array)
      expect(workflow.nodes.length).toBeGreaterThan(0)
      expect(workflow.connections).toBeDefined()
      expect(workflow._meta?.description).toBeTruthy()
      expect(workflow._meta?.setup).toBeInstanceOf(Array)
    })
  }
})
