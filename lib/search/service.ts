/**
 * Hybrid search (vector + FTS + trigram, weighted RRF, visibility before
 * ranking). docs/parity/m6.md, B5; owner: Package B.
 *
 * STEP 0 STUB: always `mode: "empty"`.
 */
import type { SearchContext, SearchParams, SearchResponse } from "@/lib/search/types"

export async function searchWorkspace(
  ctx: SearchContext,
  params: SearchParams
): Promise<SearchResponse> {
  void ctx

  return {
    query: { q: params.q, folded: params.q, tokens: [] },
    mode: "empty",
    groups: params.group === "meeting" ? [] : undefined,
    hits: params.group === "chunk" ? [] : undefined,
    nextCursor: null,
    tookMs: 0,
  }
}
