/**
 * Retrieval metrics (docs/parity/m6.md, B8): recall@1/5/10 and MRR@10 per
 * category and overall. A query's rank is the 1-based position of its first
 * relevant hit (null when none in the list).
 */
import type { EvalCategory, EvalQuery } from "@/lib/search/eval/corpus"

/** One ranked result as the eval sees it (no text). */
export type EvalHit = { meetingId: string; segmentIds: string[] }

export type Metrics = { n: number; recall1: number; recall5: number; recall10: number; mrr10: number }

export type QueryResult = { id: string; category: EvalCategory; rank: number | null }

export function isRelevant(hit: EvalHit, gold: EvalQuery["gold"]): boolean {
  if (hit.meetingId !== gold.meetingId) return false

  return gold.segmentIds.length === 0 || hit.segmentIds.some((id) => gold.segmentIds.includes(id))
}

export function firstRelevantRank(hits: EvalHit[], gold: EvalQuery["gold"]): number | null {
  const index = hits.findIndex((hit) => isRelevant(hit, gold))

  return index >= 0 ? index + 1 : null
}

export function metricsOf(results: QueryResult[]): Metrics {
  const n = results.length
  const recall = (k: number) => (n ? results.filter((result) => result.rank !== null && result.rank <= k).length / n : 0)
  const mrr = n
    ? results.reduce((sum, result) => sum + (result.rank !== null && result.rank <= 10 ? 1 / result.rank : 0), 0) / n
    : 0

  return { n, recall1: recall(1), recall5: recall(5), recall10: recall(10), mrr10: mrr }
}

export function metricsByCategory(results: QueryResult[]): Record<string, Metrics> {
  const categories = [...new Set(results.map((result) => result.category))]
  const out: Record<string, Metrics> = {}

  for (const category of categories) out[category] = metricsOf(results.filter((result) => result.category === category))
  out.overall = metricsOf(results)

  return out
}
