/**
 * Search filter facets from visible meetings (docs/parity/m6.md, B7; owner:
 * Package B).
 *
 * STEP 0 STUB: empty facets.
 */
import type { SearchContext, SearchFacets } from "@/lib/search/types"

export async function listSearchFacets(ctx: SearchContext): Promise<SearchFacets> {
  void ctx

  return { people: [], speakers: [], rooms: [], tags: [], languages: [], meetingTypes: [], sources: [] }
}
