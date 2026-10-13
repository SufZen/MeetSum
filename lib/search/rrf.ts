/**
 * Weighted reciprocal-rank fusion (docs/parity/m6.md, B3; owner: Package B).
 * Pure: legs arrive already scoped and ranked.
 */
import type { LegScores } from "@/lib/search/types"

export type LegName = "vector" | "fts" | "trgm"

/** One ranked row of a leg; `score` is the similarity for the vector leg. */
export type LegRow = { id: string; score: number; startedAt?: string }

export type Legs = Partial<Record<LegName, LegRow[]>>

export type LegWeights = Record<LegName, number>

export type FusedCandidate = { id: string; score: number; legs: LegScores; startedAt?: string }

export const DEFAULT_WEIGHTS: LegWeights = { vector: 1, fts: 1, trgm: 0.5 }

export const DEFAULT_RRF_K = 60

/** `vector:1,fts:1,trgm:0.5` (MEETSUM_SEARCH_WEIGHTS); junk → defaults. */
export function parseWeights(value: string | undefined): LegWeights {
  if (!value) return { ...DEFAULT_WEIGHTS }

  const weights = { ...DEFAULT_WEIGHTS }

  for (const part of value.split(",")) {
    const [name, raw] = part.split(":").map((piece) => piece?.trim())
    const weight = Number(raw)

    if (!(name === "vector" || name === "fts" || name === "trgm") || !Number.isFinite(weight) || weight < 0) {
      return { ...DEFAULT_WEIGHTS }
    }
    weights[name] = weight
  }

  return weights
}

export function fuse(legs: Legs, options: { k: number; weights: LegWeights }): FusedCandidate[] {
  const candidates = new Map<string, FusedCandidate>()

  for (const name of ["vector", "fts", "trgm"] as const) {
    const rows = legs[name] ?? []
    const seen = new Set<string>()
    let rank = 0

    for (const row of rows) {
      if (seen.has(row.id)) continue
      seen.add(row.id)
      rank += 1

      const candidate = candidates.get(row.id) ?? { id: row.id, score: 0, legs: {} }

      candidate.score += options.weights[name] / (options.k + rank)
      candidate.startedAt ??= row.startedAt
      if (name === "vector") candidate.legs.vector = { rank, similarity: row.score }
      else candidate.legs[name] = { rank, score: row.score }
      candidates.set(row.id, candidate)
    }
  }

  return [...candidates.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score

    const ftsA = a.legs.fts?.rank ?? Number.POSITIVE_INFINITY
    const ftsB = b.legs.fts?.rank ?? Number.POSITIVE_INFINITY

    if (ftsA !== ftsB) return ftsA - ftsB

    return (b.startedAt ?? "").localeCompare(a.startedAt ?? "")
  })
}
