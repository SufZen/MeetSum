import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/search/hebrew-normalize", async () => (await import("./helpers/search-doubles")).normalizerDouble)

import { buildMeetingMemoryResults } from "@/lib/memory"
import type { MeetingRecord } from "@/lib/meetings/repository"

function meeting(id: string, text: string): MeetingRecord {
  return {
    id,
    title: `Meeting ${id}`,
    source: "upload",
    language: "he",
    status: "completed",
    retention: "audio",
    startedAt: "2026-09-01T10:00:00.000Z",
    participants: [],
    transcript: [{ id: `${id}_s1`, speaker: "דנה", startMs: 1000, endMs: 2000, text }],
  }
}

describe("lib/memory shim (normalizer-backed matching)", () => {
  const meetings = [meeting("m1", "דיברנו על בתקציב של הרבעון"), meeting("m2", "AI ו-Q3 על הפרק"), meeting("m3", "שלום")]

  it("finds prefixed Hebrew forms in both directions", () => {
    expect(buildMeetingMemoryResults(meetings, "תקציב").map((result) => result.id)).toEqual(["m1"])
    expect(buildMeetingMemoryResults(meetings, "והתקציב").map((result) => result.id)).toEqual(["m1"])
  })

  it("keeps short tokens instead of dropping them", () => {
    expect(buildMeetingMemoryResults(meetings, "AI").map((result) => result.id)).toEqual(["m2"])
    expect(buildMeetingMemoryResults(meetings, "Q3").map((result) => result.id)).toEqual(["m2"])
    expect(buildMeetingMemoryResults(meetings, "על").map((result) => result.id).sort()).toEqual(["m1", "m2"])
  })

  it("returns all meetings for an empty query and keeps the legacy shape", () => {
    const results = buildMeetingMemoryResults(meetings, "", { limit: 10 })

    expect(results).toHaveLength(3)
    expect(Object.keys(results[0]).sort()).toEqual(
      ["actionItems", "id", "matchCount", "matches", "overview", "startedAt", "status", "tags", "title", "transcriptMatches"].sort()
    )
  })
})
