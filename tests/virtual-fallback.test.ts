import { describe, expect, it } from "vitest"

import { FALLBACK_ROW_COUNT, withFallbackRange } from "@/lib/player/virtual-fallback"

const rows = (n: number) => Array.from({ length: n }, (_, index) => ({ index, start: index * 88 }))

describe("withFallbackRange", () => {
  it("keeps the virtualizer's items when it produced any", () => {
    const items = rows(2)

    expect(withFallbackRange(items, rows(50), 50)).toBe(items)
  })

  it("falls back to the first rows when the viewport has no height", () => {
    expect(withFallbackRange([], rows(3), 3)).toEqual(rows(3))
  })

  it("caps the fallback at the limit", () => {
    expect(withFallbackRange([], rows(100), 100)).toHaveLength(FALLBACK_ROW_COUNT)
    expect(withFallbackRange([], rows(100), 100, 4)).toEqual(rows(4))
  })

  it("never exceeds the current count (stale measurements)", () => {
    expect(withFallbackRange([], rows(10), 2)).toEqual(rows(2))
  })

  it("renders nothing for an empty list", () => {
    expect(withFallbackRange([], [], 0)).toEqual([])
    expect(withFallbackRange([], rows(5), 0)).toEqual([])
  })
})
