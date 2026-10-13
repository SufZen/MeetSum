import { afterEach, describe, expect, it, vi } from "vitest"

import {
  enqueueIndexSweeps,
  getIndexStatus,
  indexSweepBatch,
  indexSweepEveryMs,
  requestWorkspaceReindex,
  selectStaleMeetings,
  sweepWorkspaceIndex,
} from "@/lib/search/index-sweep"

const flat = (sql: string) => sql.replace(/\s+/g, " ").trim()
const KEY = { model: "gemini-embedding-001", dimensions: 1536 }

function recorder(rows: unknown[] = []) {
  const calls: { text: string; values: unknown[] }[] = []
  const db = {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      calls.push({ text: flat(text), values })
      return { rows }
    }),
  }

  return { db, calls }
}

afterEach(() => vi.unstubAllEnvs())

describe("selectStaleMeetings", () => {
  it("selects usable stale meetings of one workspace, failed ones at most every 6 h", async () => {
    const { db, calls } = recorder([{ id: "m1", workspace_id: "ws_1" }])

    await expect(
      selectStaleMeetings(db, { workspaceId: "ws_1", activeKey: KEY, vectorCapable: false, limit: 50 })
    ).resolves.toEqual([{ meetingId: "m1", workspaceId: "ws_1" }])

    const [{ text, values }] = calls

    expect(text).toMatch(/^select m\.id, m\.workspace_id from meetings m where m\.workspace_id = \$1 and/)
    expect(text).toContain("exists (select 1 from transcript_segments ts where ts.meeting_id = m.id)")
    expect(text).toContain("exists (select 1 from summaries s where s.meeting_id = m.id)")
    expect(text).toContain(
      "(m.search_index_state = 'failed' and coalesce(m.search_indexed_at, '-infinity'::timestamptz) < now() - interval '6 hours')"
    )
    expect(text).toContain("m.search_index_state = 'pending'")
    expect(text).toContain("m.search_indexed_version is distinct from m.transcript_version")
    expect(text).toContain("m.search_requested_at > coalesce(m.search_indexed_at, '-infinity'::timestamptz)")
    expect(text).not.toContain("search_embedding_key")
    expect(text).toMatch(/limit \$2$/)
    expect(values).toEqual(["ws_1", 50])
  })

  it("adds the lexical and key-change catch-up only when vectors are possible", async () => {
    const { db, calls } = recorder()

    await selectStaleMeetings(db, { workspaceId: "ws_1", activeKey: KEY, vectorCapable: true, limit: 5_000 })

    expect(calls[0].text).toContain(
      "or (m.search_index_state = 'ready' and (m.search_index_mode = 'lexical' or m.search_embedding_key is distinct from $3))"
    )
    expect(calls[0].values).toEqual(["ws_1", 1_000, "gemini-embedding-001:1536"])
  })
})

describe("sweepWorkspaceIndex", () => {
  it("enqueues each stale meeting and keeps going when one enqueue fails", async () => {
    const { db } = recorder([
      { id: "m1", workspace_id: "ws_1" },
      { id: "m2", workspace_id: "ws_1" },
      { id: "m3", workspace_id: "ws_1" },
    ])
    const enqueue = vi.fn(async (meeting: { meetingId: string }) => {
      if (meeting.meetingId === "m2") throw new Error("queue_unavailable")
    })
    const log = { warn: vi.fn() }

    await expect(
      sweepWorkspaceIndex("ws_1", { limit: 10 }, { db, activeKey: KEY, vectorCapable: true, enqueue, log })
    ).resolves.toEqual({ selected: 3, enqueued: 2, failed: 1 })
    expect(enqueue).toHaveBeenCalledWith({ meetingId: "m1", workspaceId: "ws_1" })
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it("is a no-op without Postgres", async () => {
    vi.stubEnv("MEETSUM_STORAGE", "memory")
    await expect(sweepWorkspaceIndex("ws_1")).resolves.toEqual({ selected: 0, enqueued: 0, failed: 0 })
  })
})

describe("enqueueIndexSweeps", () => {
  it("enqueues one sweep per live workspace", async () => {
    const { db, calls } = recorder([{ id: "ws_1" }, { id: "ws_2" }])
    const enqueue = vi.fn(async () => undefined)

    await expect(enqueueIndexSweeps({ db, enqueue })).resolves.toBe(2)
    expect(calls[0].text).toBe("select id from workspaces where deleted_at is null order by created_at asc")
    expect(enqueue.mock.calls).toEqual([["ws_1"], ["ws_2"]])
  })
})

describe("admin status SQL", () => {
  it("counts by state and mode and the active key's coverage within the workspace", async () => {
    const calls: { text: string; values: unknown[] }[] = []
    const db = {
      query: vi.fn(async (text: string, values: unknown[] = []) => {
        calls.push({ text: flat(text), values })
        return text.includes("group by")
          ? {
              rows: [
                { state: "pending", mode: null, count: 2 },
                { state: "ready", mode: "hybrid", count: 5 },
              ],
            }
          : { rows: [{ covered: 4, ready: 5 }] }
      }),
    }

    await expect(getIndexStatus(db, "ws_1", KEY)).resolves.toEqual({
      counts: [
        { state: "pending", mode: null, count: 2 },
        { state: "ready", mode: "hybrid", count: 5 },
      ],
      total: 7,
      activeKey: "gemini-embedding-001:1536",
      activeKeyCoverage: { meetings: 4, ready: 5 },
    })
    for (const call of calls) {
      expect(call.text).toContain("where m.workspace_id = $1")
      expect(call.values[0]).toBe("ws_1")
    }
  })

  it("marks a workspace for re-indexing", async () => {
    const { db, calls } = recorder([{ count: 12 }])

    await expect(requestWorkspaceReindex(db, "ws_1")).resolves.toBe(12)
    expect(calls[0].text).toContain("update meetings set search_requested_at = now() where workspace_id = $1")
  })
})

describe("sweep config", () => {
  it("reads MEETSUM_INDEX_SWEEP_EVERY_MS and MEETSUM_INDEX_SWEEP_BATCH", () => {
    expect(indexSweepEveryMs({})).toBe(600_000)
    expect(indexSweepEveryMs({ MEETSUM_INDEX_SWEEP_EVERY_MS: "60000" })).toBe(60_000)
    expect(indexSweepEveryMs({ MEETSUM_INDEX_SWEEP_EVERY_MS: "5" })).toBe(600_000)
    expect(indexSweepBatch({})).toBe(50)
    expect(indexSweepBatch({ MEETSUM_INDEX_SWEEP_BATCH: "20" })).toBe(20)
  })
})
