import { describe, expect, it } from "vitest"

import type { MeetingRecord } from "@/lib/meetings/repository"

type SearchResult = {
  id: string
  title: string
  startedAt: string
  status: string
  source: string
  overview: string
  participantCount: number
  tags: string[]
  isFavorite: boolean
}

function searchMeetings(
  meetings: Partial<MeetingRecord>[],
  options: { q?: string; tag?: string; status?: string; source?: string; limit?: number }
): SearchResult[] {
  const { q, tag, status, source, limit = 20 } = options

  return meetings
    .filter((m) => {
      if (q) {
        const lower = q.toLowerCase()
        const titleMatch = (m.title ?? "").toLowerCase().includes(lower)
        const participantMatch = (m.participants ?? []).some((p) =>
          p.toLowerCase().includes(lower)
        )
        const overviewMatch = (m.summary?.overview ?? "").toLowerCase().includes(lower)

        if (!titleMatch && !participantMatch && !overviewMatch) return false
      }

      if (tag && !(m.tags ?? []).some((t) => String(t).toLowerCase() === tag.toLowerCase())) {
        return false
      }

      if (status && m.status !== status) return false
      if (source && m.source !== source) return false

      return true
    })
    .slice(0, limit)
    .map((m) => ({
      id: m.id!,
      title: m.title!,
      startedAt: m.startedAt!,
      status: m.status!,
      source: m.source!,
      overview: (m.summary?.overview ?? "").slice(0, 200),
      participantCount: m.participants?.length ?? 0,
      tags: (m.tags ?? []) as string[],
      isFavorite: m.isFavorite ?? false,
    }))
}

const sampleMeetings: Partial<MeetingRecord>[] = [
  {
    id: "m1",
    title: "Engineering Standup",
    startedAt: "2026-05-28T09:00:00Z",
    status: "completed",
    source: "google_meet",
    participants: ["Alice", "Bob"],
    summary: { overview: "Discussed Sprint 5 progress.", decisions: [], actionItems: [] },
    tags: ["technical" as const, "product" as const],
    isFavorite: true,
  },
  {
    id: "m2",
    title: "Sales Pipeline Review",
    startedAt: "2026-05-28T14:00:00Z",
    status: "completed",
    source: "upload",
    participants: ["Charlie", "Diana"],
    summary: { overview: "Reviewed Q3 sales pipeline targets.", decisions: [], actionItems: [] },
    tags: ["sales" as const, "follow-up-needed" as const],
    isFavorite: false,
  },
  {
    id: "m3",
    title: "Product Design Workshop",
    startedAt: "2026-05-27T10:00:00Z",
    status: "summarizing",
    source: "google_meet",
    participants: ["Alice", "Eve"],
    summary: undefined,
    tags: ["product" as const, "technical" as const],
  },
]

describe("meeting search", () => {
  it("searches by title keyword", () => {
    const results = searchMeetings(sampleMeetings, { q: "standup" })

    expect(results).toHaveLength(1)
    expect(results[0].title).toBe("Engineering Standup")
  })

  it("searches by participant name", () => {
    const results = searchMeetings(sampleMeetings, { q: "charlie" })

    expect(results).toHaveLength(1)
    expect(results[0].id).toBe("m2")
  })

  it("searches by summary overview text", () => {
    const results = searchMeetings(sampleMeetings, { q: "Q3 sales" })

    expect(results).toHaveLength(1)
    expect(results[0].id).toBe("m2")
  })

  it("filters by tag", () => {
    const results = searchMeetings(sampleMeetings, { tag: "sales" })

    expect(results).toHaveLength(1)
    expect(results[0].id).toBe("m2")
  })

  it("filters by status", () => {
    const results = searchMeetings(sampleMeetings, { status: "completed" })

    expect(results).toHaveLength(2)
  })

  it("filters by source", () => {
    const results = searchMeetings(sampleMeetings, { source: "upload" })

    expect(results).toHaveLength(1)
    expect(results[0].id).toBe("m2")
  })

  it("combines q + tag filter", () => {
    const results = searchMeetings(sampleMeetings, { q: "alice", tag: "product" })

    expect(results).toHaveLength(2)
    expect(results.map((r) => r.id)).toContain("m1")
    expect(results.map((r) => r.id)).toContain("m3")
  })

  it("respects limit", () => {
    const results = searchMeetings(sampleMeetings, { status: "completed", limit: 1 })

    expect(results).toHaveLength(1)
  })

  it("returns empty for no matches", () => {
    const results = searchMeetings(sampleMeetings, { q: "nonexistent" })

    expect(results).toHaveLength(0)
  })

  it("preserves isFavorite flag", () => {
    const results = searchMeetings(sampleMeetings, { q: "standup" })

    expect(results[0].isFavorite).toBe(true)
  })
})
