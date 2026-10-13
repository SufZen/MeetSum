import { describe, expect, it, vi } from "vitest"

import { resolveCitation } from "@/lib/player/citations"
import { createPlayerStore } from "@/lib/player/store"

/**
 * MeetingPlayerProvider reads `store.index` through useSyncExternalStore so
 * citation chips resolve as soon as segments are indexed (they used to
 * appear only after visiting the Transcript tab). That relies on the store
 * contract checked here: setSegments emits and replaces the index object,
 * playback ticks keep the same object (no re-render of every chip).
 */
describe("player store index snapshot", () => {
  const segments = [
    { id: "s1", speaker: "Dana", startMs: 0, endMs: 4000, text: "a" },
    { id: "s2", speaker: "Avi", startMs: 4000, endMs: 9000, text: "b" },
  ]

  it("emits and replaces the index when segments load, and keeps it across ticks", () => {
    const store = createPlayerStore({ durationMs: 9000 })
    const listener = vi.fn()

    store.subscribe(listener)
    const empty = store.index()

    expect(resolveCitation([], empty, { segmentId: "s2" })).toBeUndefined()

    store.setSegments(segments as never)
    const loaded = store.index()

    expect(listener).toHaveBeenCalled()
    expect(loaded).not.toBe(empty)
    expect(resolveCitation(segments as never, loaded, { segmentId: "s2" })).toMatchObject({ segmentId: "s2" })

    store.setTime(5000, { force: true })
    store.patch({ playing: true })
    expect(store.index()).toBe(loaded)
  })
})
