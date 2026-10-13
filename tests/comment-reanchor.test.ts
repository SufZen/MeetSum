import { describe, expect, it, vi } from "vitest"

import { createCollabMemoryDb, type StoredComment } from "@/lib/clips/db"
import { reanchorMeetingComments } from "@/lib/comments/reanchor"
import { segmentForTime } from "@/lib/comments/targets"

/**
 * M5 C3 re-anchoring: after `replaceTranscript` changes segment ids, a
 * segment comment moves to the segment containing its `anchor.startMs`.
 */

function comment(overrides: Partial<StoredComment> & { id: string }): StoredComment {
  return {
    workspaceId: "ws_a",
    meetingId: "m_a",
    targetType: "segment",
    targetId: "old_2",
    authorUserId: "user_me",
    body: "x",
    mentions: [],
    anchor: { startMs: 4500 },
    createdAt: "2026-10-01T10:00:00.000Z",
    ...overrides,
  }
}

const NEW_SEGMENTS = [
  { id: "new_1", startMs: 0, endMs: 3000 },
  { id: "new_2", startMs: 3000, endMs: 6000 },
  { id: "new_3", startMs: 8000, endMs: 12_000 },
]

describe("reanchorMeetingComments", () => {
  it("re-points segment comments to the segment containing their time", async () => {
    const db = createCollabMemoryDb()

    db.comments.set("c1", comment({ id: "c1" }))
    db.comments.set("c2", comment({ id: "c2", targetId: "old_3", anchor: { startMs: 7000 } }))
    db.comments.set("c3", comment({ id: "c3", targetId: "new_1", anchor: { startMs: 100 } }))
    db.comments.set("c4", comment({ id: "c4", targetId: "old_9", anchor: { quote: "no time" } }))
    db.comments.set("c5", comment({ id: "c5", targetType: "summary_item", targetId: "si_1", anchor: {} }))
    db.comments.set("c6", comment({ id: "c6", meetingId: "m_other" }))

    const loadSegments = vi.fn(async () => NEW_SEGMENTS)
    const result = await reanchorMeetingComments("m_a", { backend: { kind: "memory", db }, loadSegments })

    expect(result).toEqual({ updated: 2 })
    expect(loadSegments).toHaveBeenCalledWith("ws_a", "m_a")
    expect(db.comments.get("c1")?.targetId).toBe("new_2")
    // In a gap: the nearest segment before it.
    expect(db.comments.get("c2")?.targetId).toBe("new_2")
    expect(db.comments.get("c3")?.targetId).toBe("new_1")
    expect(db.comments.get("c4")?.targetId).toBe("old_9")
    expect(db.comments.get("c5")?.targetId).toBe("si_1")
    expect(db.comments.get("c6")?.targetId).toBe("old_2")
  })

  it("updates Postgres rows in one statement scoped to the meeting and workspace", async () => {
    const statements: Array<{ text: string; values: unknown[] }> = []
    const client = {
      async query(text: string, values: unknown[] = []) {
        statements.push({ text, values })
        return text.includes("select c.id")
          ? { rows: [{ id: "c1", workspace_id: "ws_a", target_id: "old_2", anchor: { startMs: 4500 } }] }
          : { rows: [] }
      },
    }

    expect(
      await reanchorMeetingComments("m_a", {
        backend: { kind: "postgres", client },
        loadSegments: async () => NEW_SEGMENTS,
      })
    ).toEqual({ updated: 1 })
    expect(statements[0].text).toMatch(/c\.target_type = 'segment' and c\.deleted_at is null/)
    expect(statements[1].text).toMatch(/unnest\(\$1::text\[\], \$2::text\[\]\)/)
    expect(statements[1].values).toEqual([["c1"], ["new_2"], "m_a", "ws_a"])
  })

  it("never throws (it runs inside transcription jobs)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)

    const client = {
      async query(): Promise<{ rows: unknown[] }> {
        throw new Error("db down")
      },
    }

    await expect(reanchorMeetingComments("m_a", { backend: { kind: "postgres", client } })).resolves.toEqual({
      updated: 0,
    })
  })

  it("finds the containing, else preceding, else first segment", () => {
    expect(segmentForTime(NEW_SEGMENTS, 3000)).toBe("new_2")
    expect(segmentForTime(NEW_SEGMENTS, 7000)).toBe("new_2")
    expect(segmentForTime(NEW_SEGMENTS, 50_000)).toBe("new_3")
    expect(segmentForTime([{ id: "a", startMs: 500, endMs: 900 }], 100)).toBe("a")
    expect(segmentForTime([], 100)).toBeUndefined()
  })
})
