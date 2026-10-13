import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ enqueue: vi.fn() }))

vi.mock("@/lib/jobs/queue", () => ({ enqueueMeetSumJob: mocks.enqueue }))

import { meetingIndexJobId, requestMeetingReindex } from "@/lib/search/index-trigger"

describe("requestMeetingReindex (M6 Step 0)", () => {
  beforeEach(() => {
    mocks.enqueue.mockReset().mockResolvedValue({ id: "job_1" })
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it("is a no-op with in-memory storage (no persisted index)", async () => {
    vi.stubEnv("MEETSUM_STORAGE", "memory")

    await requestMeetingReindex({ workspaceId: "ws_1", meetingId: "m_1", reason: "renamed" })

    expect(mocks.enqueue).not.toHaveBeenCalled()
  })

  it("marks the meeting in its workspace, then enqueues one debounced job per meeting", async () => {
    vi.stubEnv("MEETSUM_INDEX_DEBOUNCE_MS", "2500")
    const query = vi.fn().mockResolvedValue({ rows: [] })

    await requestMeetingReindex({ workspaceId: "ws_1", meetingId: "m_1", reason: "transcript.edited", db: { query } })

    expect(query).toHaveBeenCalledWith(
      "update meetings set search_requested_at = now() where id = $1 and workspace_id = $2",
      ["m_1", "ws_1"]
    )
    expect(mocks.enqueue).toHaveBeenCalledWith(
      "meeting.index",
      { meetingId: "m_1", workspaceId: "ws_1", reason: "transcript.edited" },
      { jobId: "meeting.index-m_1", delay: 2500 }
    )
  })

  it("bounds the enqueue so a Redis outage doesn't stall the edit route", async () => {
    vi.stubEnv("MEETSUM_INDEX_ENQUEUE_TIMEOUT_MS", "50")
    mocks.enqueue.mockReturnValue(new Promise(() => {}))
    const query = vi.fn().mockResolvedValue({ rows: [] })
    const started = Date.now()

    await requestMeetingReindex({ workspaceId: "ws_1", meetingId: "m_1", reason: "renamed", db: { query } })

    expect(Date.now() - started).toBeLessThan(1_000)
    expect(console.warn).toHaveBeenCalledWith("[search] reindex enqueue failed", "renamed", "TimeoutError")
  })

  it("never throws: database and queue failures are logged", async () => {
    const query = vi.fn().mockRejectedValue(new Error("relation does not exist"))
    mocks.enqueue.mockRejectedValue(new Error("queue_unavailable"))

    await expect(
      requestMeetingReindex({ workspaceId: "ws_1", meetingId: "m_1", reason: "tags", db: { query } })
    ).resolves.toBeUndefined()
    expect(mocks.enqueue).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledTimes(2)
  })

  it("uses BullMQ-safe job ids (no colon)", () => {
    expect(meetingIndexJobId("a:b")).toBe("meeting.index-a_b")
  })
})
