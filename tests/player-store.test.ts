import { describe, expect, it } from "vitest"

import { TIME_EMIT_INTERVAL_MS, createPlayerStore } from "@/lib/player/store"

const segments = [
  { id: "a", startMs: 0, endMs: 2_000, words: [[0, 500, "שלום", 0.9], [600, 1_200, "לכולם", null]] },
  { id: "b", startMs: 2_000, endMs: 4_000 },
  { id: "c", startMs: 8_000, endMs: 9_000, words: [{ startMs: 8_000, endMs: 8_400, text: "ok" }] },
]

function setup() {
  let clock = 0
  const store = createPlayerStore({ durationMs: 10_000 }, { now: () => clock })
  let emits = 0

  store.subscribe(() => {
    emits += 1
  })
  store.setSegments(segments)
  emits = 0

  return {
    store,
    advance: (ms: number) => {
      clock += ms
    },
    emits: () => emits,
  }
}

describe("createPlayerStore", () => {
  it("derives the active segment and word from the playhead", () => {
    const { store } = setup()

    store.setTime(700, { force: true })
    expect(store.getState()).toMatchObject({ currentMs: 700, activeSegmentIndex: 0, activeWordIndex: 1 })

    store.setTime(3_000, { force: true })
    expect(store.getState()).toMatchObject({ activeSegmentIndex: 1, activeWordIndex: -1 })

    store.setTime(6_000, { force: true })
    expect(store.getState()).toMatchObject({ activeSegmentIndex: -1, activeWordIndex: -1 })

    store.setTime(8_100, { force: true })
    expect(store.getState()).toMatchObject({ activeSegmentIndex: 2, activeWordIndex: 0 })
  })

  it("throttles time-only updates to ~15 Hz but emits active changes at once", () => {
    const { store, advance, emits } = setup()

    store.setTime(100, { force: true })
    expect(emits()).toBe(1)

    advance(10)
    store.setTime(150) // same word, too soon
    expect(emits()).toBe(1)
    expect(store.getState().currentMs).toBe(150)

    advance(10)
    store.setTime(650) // word changed
    expect(emits()).toBe(2)

    advance(TIME_EMIT_INTERVAL_MS)
    store.setTime(700) // same word, interval passed
    expect(emits()).toBe(3)
  })

  it("clamps to the duration and to zero", () => {
    const { store } = setup()

    store.setTime(99_000, { force: true })
    expect(store.getState().currentMs).toBe(10_000)
    store.setTime(-5, { force: true })
    expect(store.getState().currentMs).toBe(0)
  })

  it("patches only on real changes", () => {
    const { store, emits } = setup()

    store.patch({ playing: false })
    expect(emits()).toBe(0)
    store.patch({ playing: true, rate: 1.5 })
    expect(emits()).toBe(1)
    expect(store.getState()).toMatchObject({ playing: true, rate: 1.5 })
  })

  it("decodes words lazily and memoizes by id + revision", () => {
    const { store } = setup()
    const first = store.wordsFor(0)

    expect(first.map((word) => word.text)).toEqual(["שלום", "לכולם"])
    expect(store.wordsFor(0)).toBe(first)
    expect(store.wordsFor(1)).toEqual([])
    expect(store.wordsFor(99)).toEqual([])
  })
})
