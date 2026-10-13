import { describe, expect, it } from "vitest"

import { DEFAULT_WEIGHTS, fuse, parseWeights } from "@/lib/search/rrf"

describe("fuse (weighted RRF)", () => {
  it("sums weighted reciprocal ranks across legs", () => {
    const fused = fuse(
      {
        vector: [{ id: "a", score: 0.9 }, { id: "b", score: 0.8 }],
        fts: [{ id: "b", score: 0.5 }, { id: "c", score: 0.4 }],
        trgm: [{ id: "c", score: 0.7 }],
      },
      { k: 60, weights: DEFAULT_WEIGHTS }
    )

    expect(fused.map((candidate) => candidate.id)).toEqual(["b", "c", "a"])
    expect(fused[0].score).toBeCloseTo(1 / 62 + 1 / 61, 10)
    expect(fused[0].legs).toEqual({ vector: { rank: 2, similarity: 0.8 }, fts: { rank: 1, score: 0.5 } })
    expect(fused[1].score).toBeCloseTo(1 / 62 + 0.5 / 61, 10)
  })

  it("breaks ties by FTS rank, then by the more recent meeting", () => {
    const fused = fuse(
      {
        fts: [{ id: "x", score: 1 }],
        trgm: [{ id: "y", score: 1, startedAt: "2026-01-01" }, { id: "z", score: 1, startedAt: "2026-05-01" }],
      },
      { k: 60, weights: { vector: 1, fts: 1, trgm: 1 } }
    )

    expect(fused.map((candidate) => candidate.id)).toEqual(["x", "y", "z"])

    const tie = fuse(
      { trgm: [{ id: "old", score: 1, startedAt: "2026-01-01" }], vector: [{ id: "new", score: 1, startedAt: "2026-05-01" }] },
      { k: 60, weights: { vector: 1, fts: 1, trgm: 1 } }
    )

    expect(tie.map((candidate) => candidate.id)).toEqual(["new", "old"])
  })

  it("ignores duplicate ids within one leg (first rank wins)", () => {
    const fused = fuse({ fts: [{ id: "a", score: 2 }, { id: "a", score: 1 }] }, { k: 60, weights: DEFAULT_WEIGHTS })

    expect(fused).toHaveLength(1)
    expect(fused[0].legs.fts).toEqual({ rank: 1, score: 2 })
  })
})

describe("parseWeights", () => {
  it("parses the env format and falls back on junk", () => {
    expect(parseWeights("vector:2,fts:1,trgm:0.25")).toEqual({ vector: 2, fts: 1, trgm: 0.25 })
    expect(parseWeights("vector:x,nope")).toEqual(DEFAULT_WEIGHTS)
    expect(parseWeights(undefined)).toEqual(DEFAULT_WEIGHTS)
  })
})
