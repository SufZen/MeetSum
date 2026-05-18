import { describe, expect, it } from "vitest"

import { buildMeetingMemoryResults, type MemorySearchFilters } from "@/lib/memory"
import type { MeetingRecord } from "@/lib/meetings/repository"

function meeting(overrides: Partial<MeetingRecord> = {}): MeetingRecord {
  return {
    id: "meeting_1",
    title: "Default meeting",
    source: "google_meet",
    language: "en",
    status: "completed",
    retention: "audio",
    startedAt: new Date().toISOString(),
    participants: ["Alice", "Bob"],
    summary: { overview: "A productive meeting", decisions: [], actionItems: [] },
    tags: ["technical"],
    ...overrides,
  }
}

describe("memory search filters", () => {
  const meetings: MeetingRecord[] = [
    meeting({
      id: "m-1",
      title: "Architecture review",
      tags: ["technical", "product"],
      participants: ["Alice", "Charlie"],
      contexts: [
        { id: "room-eng", name: "Engineering", createdAt: "2025-01-01T00:00:00Z" },
      ],
      languageMetadata: {
        primaryLanguage: "en",
        secondaryLanguages: [],
        segmentLanguages: [],
        confidence: 0.9,
        mixedLanguage: false,
      },
    }),
    meeting({
      id: "m-2",
      title: "Budget planning",
      tags: ["finance"],
      participants: ["Bob", "Dana"],
      contexts: [
        { id: "room-ops", name: "Operations", createdAt: "2025-01-01T00:00:00Z" },
      ],
      languageMetadata: {
        primaryLanguage: "he",
        secondaryLanguages: ["en"],
        segmentLanguages: [],
        confidence: 0.85,
        mixedLanguage: true,
      },
    }),
    meeting({
      id: "m-3",
      title: "Client demo",
      tags: ["sales"],
      participants: ["Alice", "Bob"],
    }),
  ]

  it("returns all meetings when no filters are applied", () => {
    const results = buildMeetingMemoryResults(meetings, "")

    expect(results).toHaveLength(3)
  })

  it("filters by room ID", () => {
    const filters: MemorySearchFilters = { roomId: "room-eng" }
    const results = buildMeetingMemoryResults(meetings, "", { filters })

    expect(results).toHaveLength(1)
    expect(results[0].id).toBe("m-1")
  })

  it("filters by tag", () => {
    const filters: MemorySearchFilters = { tag: "finance" }
    const results = buildMeetingMemoryResults(meetings, "", { filters })

    expect(results).toHaveLength(1)
    expect(results[0].id).toBe("m-2")
  })

  it("filters by participant name (case-insensitive)", () => {
    const filters: MemorySearchFilters = { participant: "dana" }
    const results = buildMeetingMemoryResults(meetings, "", { filters })

    expect(results).toHaveLength(1)
    expect(results[0].id).toBe("m-2")
  })

  it("filters by primary language", () => {
    const filters: MemorySearchFilters = { language: "he" }
    const results = buildMeetingMemoryResults(meetings, "", { filters })

    expect(results).toHaveLength(1)
    expect(results[0].id).toBe("m-2")
  })

  it("combines multiple filters with AND logic", () => {
    const filters: MemorySearchFilters = { tag: "technical", participant: "alice" }
    const results = buildMeetingMemoryResults(meetings, "", { filters })

    expect(results).toHaveLength(1)
    expect(results[0].id).toBe("m-1")
  })

  it("returns empty when filters match no meetings", () => {
    const filters: MemorySearchFilters = { roomId: "room-nonexistent" }
    const results = buildMeetingMemoryResults(meetings, "", { filters })

    expect(results).toHaveLength(0)
  })

  it("combines text query with filters", () => {
    const filters: MemorySearchFilters = { participant: "alice" }
    const results = buildMeetingMemoryResults(meetings, "productive", { filters })

    // "productive" matches the summary overview on m-1, m-2, m-3 but
    // participant filter "alice" narrows to m-1 and m-3
    expect(results).toHaveLength(2)
    expect(results.map((r) => r.id).sort()).toEqual(["m-1", "m-3"])
    expect(results[0].matchCount).toBeGreaterThan(0)
  })
})
