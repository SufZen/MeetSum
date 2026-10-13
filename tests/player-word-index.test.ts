import { describe, expect, it } from "vitest"

import {
  WORD_TAIL_MS,
  buildTranscriptIndex,
  findSegmentAt,
  findWordAt,
} from "@/lib/player/word-index"

const segments = [
  { startMs: 0, endMs: 2_000 },
  { startMs: 2_000, endMs: 5_000 },
  { startMs: 8_000, endMs: 9_000 },
]

describe("buildTranscriptIndex", () => {
  it("packs starts and ends into Int32Arrays", () => {
    const index = buildTranscriptIndex(segments)

    expect(index.starts).toBeInstanceOf(Int32Array)
    expect(Array.from(index.starts)).toEqual([0, 2_000, 8_000])
    expect(Array.from(index.ends)).toEqual([2_000, 5_000, 9_000])
    expect(index.length).toBe(3)
  })

  it("is empty for no segments", () => {
    expect(buildTranscriptIndex([]).length).toBe(0)
  })
})

describe("findSegmentAt", () => {
  const index = buildTranscriptIndex(segments)

  it("returns -1 before the first segment and for an empty index", () => {
    expect(findSegmentAt(buildTranscriptIndex([{ startMs: 500, endMs: 900 }]), 100)).toEqual({
      index: -1,
      inGap: true,
    })
    expect(findSegmentAt(buildTranscriptIndex([]), 0)).toEqual({ index: -1, inGap: true })
  })

  it("finds the last segment starting at or before the time", () => {
    expect(findSegmentAt(index, 0)).toEqual({ index: 0, inGap: false })
    expect(findSegmentAt(index, 1_999)).toEqual({ index: 0, inGap: false })
    expect(findSegmentAt(index, 2_000)).toEqual({ index: 1, inGap: false })
    expect(findSegmentAt(index, 8_500)).toEqual({ index: 2, inGap: false })
  })

  it("flags silence between segments as a gap but keeps the previous segment", () => {
    expect(findSegmentAt(index, 6_000)).toEqual({ index: 1, inGap: true })
    expect(findSegmentAt(index, 60_000)).toEqual({ index: 2, inGap: true })
  })

  it("stays fast and exact on 100k segments", () => {
    const many = Array.from({ length: 100_000 }, (_, i) => ({
      startMs: i * 3_000,
      endMs: i * 3_000 + 2_500,
    }))
    const big = buildTranscriptIndex(many)
    const started = performance.now()

    for (let probe = 0; probe < 10_000; probe += 1) {
      const ms = (probe * 29_989) % (100_000 * 3_000)
      const { index: found } = findSegmentAt(big, ms)

      expect(found).toBe(Math.floor(ms / 3_000))
    }

    expect(performance.now() - started).toBeLessThan(1_000)
    expect(findSegmentAt(big, 299_999_800)).toEqual({ index: 99_999, inGap: true })
  })
})

describe("findWordAt", () => {
  const words = [
    { startMs: 0, endMs: 300 },
    { startMs: 400, endMs: 700 },
    { startMs: 2_000, endMs: 2_300 },
  ]

  it("finds the word being spoken", () => {
    expect(findWordAt(words, 0)).toBe(0)
    expect(findWordAt(words, 450)).toBe(1)
    expect(findWordAt(words, 2_100)).toBe(2)
  })

  it("keeps the previous word lit for a short tail, then lets it go", () => {
    expect(findWordAt(words, 350)).toBe(0)
    expect(findWordAt(words, 700 + WORD_TAIL_MS - 1)).toBe(1)
    expect(findWordAt(words, 700 + WORD_TAIL_MS)).toBe(-1)
  })

  it("returns -1 before the first word or without words", () => {
    expect(findWordAt([{ startMs: 100, endMs: 200 }], 50)).toBe(-1)
    expect(findWordAt([], 50)).toBe(-1)
  })
})
