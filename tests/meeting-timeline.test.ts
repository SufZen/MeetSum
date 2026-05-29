import { describe, expect, it } from "vitest"

type TimelineEntry = {
  id: string
  title: string
  startedAt: string
  status: string
  source: string
  participantCount: number
  hasTranscript: boolean
  hasSummary: boolean
  actionItemCount: number
  openActionItems: number
  tags: string[]
  contextId?: string
}

type TimelineGroup = {
  period: string
  meetingCount: number
  meetings: TimelineEntry[]
}

type TimelineStats = {
  totalMeetings: number
  completedMeetings: number
  totalActionItems: number
  openActionItems: number
  meetingsWithTranscript: number
  meetingsWithSummary: number
  uniqueParticipants: number
}

function getGroupKey(dateStr: string, groupBy: string): string {
  const date = new Date(dateStr)

  if (groupBy === "month") {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`
  }

  if (groupBy === "week") {
    const d = new Date(date)
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
    return d.toISOString().split("T")[0]
  }

  return date.toISOString().split("T")[0]
}

const sampleEntries: TimelineEntry[] = [
  {
    id: "m1", title: "Standup Mon", startedAt: "2026-05-26T09:00:00Z",
    status: "completed", source: "google_meet", participantCount: 3,
    hasTranscript: true, hasSummary: true, actionItemCount: 2, openActionItems: 1,
    tags: ["standup"], contextId: "room_eng",
  },
  {
    id: "m2", title: "Standup Tue", startedAt: "2026-05-27T09:00:00Z",
    status: "completed", source: "google_meet", participantCount: 4,
    hasTranscript: true, hasSummary: true, actionItemCount: 3, openActionItems: 2,
    tags: ["standup"], contextId: "room_eng",
  },
  {
    id: "m3", title: "Client Call", startedAt: "2026-05-27T14:00:00Z",
    status: "completed", source: "manual_upload", participantCount: 2,
    hasTranscript: false, hasSummary: false, actionItemCount: 0, openActionItems: 0,
    tags: ["sales"], contextId: "room_sales",
  },
  {
    id: "m4", title: "Standup Wed", startedAt: "2026-05-28T09:00:00Z",
    status: "completed", source: "google_meet", participantCount: 3,
    hasTranscript: true, hasSummary: true, actionItemCount: 1, openActionItems: 0,
    tags: ["standup"], contextId: "room_eng",
  },
]

describe("meeting timeline grouping", () => {
  it("groups by day correctly", () => {
    const groups = new Map<string, TimelineEntry[]>()

    for (const entry of sampleEntries) {
      const key = getGroupKey(entry.startedAt, "day")
      const group = groups.get(key) ?? []

      group.push(entry)
      groups.set(key, group)
    }

    expect(groups.size).toBe(3)
    expect(groups.get("2026-05-27")).toHaveLength(2) // Tue standup + client call
    expect(groups.get("2026-05-26")).toHaveLength(1) // Mon standup
    expect(groups.get("2026-05-28")).toHaveLength(1) // Wed standup
  })

  it("groups by week correctly", () => {
    const groups = new Map<string, TimelineEntry[]>()

    for (const entry of sampleEntries) {
      const key = getGroupKey(entry.startedAt, "week")
      const group = groups.get(key) ?? []

      group.push(entry)
      groups.set(key, group)
    }

    // All entries are in the same week (May 25-31, 2026)
    expect(groups.size).toBe(1)
    const [, items] = [...groups.entries()][0]
    expect(items).toHaveLength(4)
  })

  it("groups by month correctly", () => {
    const entries: TimelineEntry[] = [
      ...sampleEntries,
      {
        id: "m5", title: "June Meeting", startedAt: "2026-06-02T10:00:00Z",
        status: "completed", source: "google_meet", participantCount: 5,
        hasTranscript: true, hasSummary: true, actionItemCount: 4, openActionItems: 3,
        tags: ["planning"],
      },
    ]

    const groups = new Map<string, TimelineEntry[]>()

    for (const entry of entries) {
      const key = getGroupKey(entry.startedAt, "month")
      const group = groups.get(key) ?? []

      group.push(entry)
      groups.set(key, group)
    }

    expect(groups.size).toBe(2)
    expect(groups.get("2026-05")).toHaveLength(4)
    expect(groups.get("2026-06")).toHaveLength(1)
  })
})

describe("meeting timeline stats", () => {
  it("calculates aggregate stats correctly", () => {
    const stats: TimelineStats = {
      totalMeetings: sampleEntries.length,
      completedMeetings: sampleEntries.filter((e) => e.status === "completed").length,
      totalActionItems: sampleEntries.reduce((sum, e) => sum + e.actionItemCount, 0),
      openActionItems: sampleEntries.reduce((sum, e) => sum + e.openActionItems, 0),
      meetingsWithTranscript: sampleEntries.filter((e) => e.hasTranscript).length,
      meetingsWithSummary: sampleEntries.filter((e) => e.hasSummary).length,
      uniqueParticipants: 8,
    }

    expect(stats.totalMeetings).toBe(4)
    expect(stats.completedMeetings).toBe(4)
    expect(stats.totalActionItems).toBe(6)
    expect(stats.openActionItems).toBe(3)
    expect(stats.meetingsWithTranscript).toBe(3)
    expect(stats.meetingsWithSummary).toBe(3)
  })
})

describe("timeline date range filtering", () => {
  it("filters entries within a date range", () => {
    const from = new Date("2026-05-27T00:00:00Z")
    const to = new Date("2026-05-28T00:00:00Z")

    const filtered = sampleEntries.filter((e) => {
      const d = new Date(e.startedAt)
      return d >= from && d < to
    })

    expect(filtered).toHaveLength(2)
    expect(filtered[0].id).toBe("m2")
    expect(filtered[1].id).toBe("m3")
  })

  it("returns empty for out-of-range dates", () => {
    const from = new Date("2025-01-01T00:00:00Z")
    const to = new Date("2025-12-31T23:59:59Z")

    const filtered = sampleEntries.filter((e) => {
      const d = new Date(e.startedAt)
      return d >= from && d < to
    })

    expect(filtered).toHaveLength(0)
  })
})

describe("timeline group sorting", () => {
  it("sorts groups chronologically", () => {
    const groups: TimelineGroup[] = [
      { period: "2026-05-28", meetingCount: 1, meetings: [] },
      { period: "2026-05-26", meetingCount: 1, meetings: [] },
      { period: "2026-05-27", meetingCount: 2, meetings: [] },
    ]

    const sorted = groups.sort((a, b) => a.period.localeCompare(b.period))

    expect(sorted[0].period).toBe("2026-05-26")
    expect(sorted[1].period).toBe("2026-05-27")
    expect(sorted[2].period).toBe("2026-05-28")
  })
})
