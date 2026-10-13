/**
 * Passage retrieval for AskMeetSum (docs/parity/m6.md, B6; owner: Package B).
 *
 * STEP 0 STUB: no passages.
 */
import type { RetrieveRequest, RetrieveResult, SearchContext } from "@/lib/search/types"

export async function retrievePassages(
  ctx: SearchContext,
  req: RetrieveRequest
): Promise<RetrieveResult> {
  void ctx
  void req

  return { passages: [], mode: "empty", topSimilarity: null, lexicalHits: 0 }
}
