import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  COLLAB_REFRESH_MS,
  commentsSubscriber,
  resetCommentsStoreForTesting,
} from "@/components/comments/collab-client"

/**
 * The comments store must not storm the API: `useSyncExternalStore` gets a
 * stable subscribe per meeting (an inline arrow resubscribed and refetched
 * on every render), polling is 15 s and pauses while the tab is hidden.
 */
describe("comments store polling", () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ threads: {}, reactions: [] }), { status: 200 }))
  const doc = { visibilityState: "visible" as "visible" | "hidden" }

  beforeEach(() => {
    vi.useFakeTimers()
    fetchMock.mockClear()
    doc.visibilityState = "visible"
    vi.stubGlobal("fetch", fetchMock)
    vi.stubGlobal("document", doc)
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() })
    resetCommentsStoreForTesting()
  })

  afterEach(() => {
    resetCommentsStoreForTesting()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it("returns the same subscribe function for a meeting on every call", () => {
    expect(commentsSubscriber("m_1")).toBe(commentsSubscriber("m_1"))
    expect(commentsSubscriber("m_1")).not.toBe(commentsSubscriber("m_2"))
  })

  it("does not refetch when components re-subscribe in quick succession", async () => {
    const subscribe = commentsSubscriber("m_1")
    const listeners = Array.from({ length: 30 }, () => vi.fn())

    // Many anchors mount, unmount and re-mount (React re-renders / strict mode).
    for (let round = 0; round < 20; round += 1) {
      const unsubscribes = listeners.map((listener) => subscribe(listener))

      await vi.advanceTimersByTimeAsync(10)
      unsubscribes.forEach((unsubscribe) => unsubscribe())
    }

    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it("polls every 15 s while visible and pauses while hidden", async () => {
    const unsubscribe = commentsSubscriber("m_1")(vi.fn())

    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(COLLAB_REFRESH_MS * 4)
    expect(fetchMock).toHaveBeenCalledTimes(5)

    doc.visibilityState = "hidden"
    await vi.advanceTimersByTimeAsync(COLLAB_REFRESH_MS * 4)
    expect(fetchMock).toHaveBeenCalledTimes(5)

    unsubscribe()
    doc.visibilityState = "visible"
    await vi.advanceTimersByTimeAsync(COLLAB_REFRESH_MS * 4)
    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(COLLAB_REFRESH_MS).toBe(15_000)
  })
})
