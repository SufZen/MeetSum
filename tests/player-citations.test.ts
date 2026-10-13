import { describe, expect, it } from "vitest"

import { buildActionItemMarkers, resolveCitation } from "@/lib/player/citations"
import { buildTranscriptIndex } from "@/lib/player/word-index"

const segments = [
  { id: "a", startMs: 0, endMs: 4_000 },
  { id: "b", startMs: 4_000, endMs: 9_000 },
  { id: "c", startMs: 20_000, endMs: 25_000 },
]
const index = buildTranscriptIndex(segments)

describe("resolveCitation", () => {
  it("resolves by segment id and keeps an in-segment start", () => {
    expect(resolveCitation(segments, index, { segmentId: "b", startMs: 5_000 })).toEqual({
      segmentIndex: 1,
      segmentId: "b",
      startMs: 5_000,
    })
    expect(resolveCitation(segments, index, { segmentId: "b", startMs: 99_000 })?.startMs).toBe(4_000)
  })

  it("falls back to the time when the id is unknown", () => {
    expect(resolveCitation(segments, index, { segmentId: "gone", startMs: 21_000 })).toEqual({
      segmentIndex: 2,
      segmentId: "c",
      startMs: 21_000,
    })
  })

  it("snaps a timestamp in short silence to the nearest segment", () => {
    expect(resolveCitation(segments, index, { startMs: 19_000 })?.segmentId).toBe("c")
    expect(resolveCitation(segments, index, { startMs: 10_000 })?.segmentId).toBe("b")
  })

  it("does not resolve deep silence, negatives or an empty transcript", () => {
    expect(resolveCitation(segments, index, { startMs: 14_000 })).toBeUndefined()
    expect(resolveCitation(segments, index, { startMs: 60_000 })).toBeUndefined()
    expect(resolveCitation(segments, index, { startMs: -1 })).toBeUndefined()
    expect(resolveCitation([], buildTranscriptIndex([]), { startMs: 1 })).toBeUndefined()
    expect(resolveCitation(segments, index, {})).toBeUndefined()
  })
})

describe("buildActionItemMarkers", () => {
  it("emits markers only for action items that resolve", () => {
    expect(
      buildActionItemMarkers(
        [
          { id: "1", title: "Send deck", sourceStartMs: 4_500 },
          { id: "2", title: "No source" },
          { id: "3", title: "Ghost", sourceStartMs: 14_000 },
        ],
        segments,
        index
      )
    ).toEqual([{ id: "action:1", startMs: 4_500, kind: "action_item", label: "Send deck" }])
  })
})
