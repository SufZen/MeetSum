/**
 * Search filter facets from the caller's visible meetings
 * (docs/parity/m6.md, B7; owner: Package B). Scoped like every search
 * statement: pg facets carry the workspace match plus `meetingScopeSql`, the
 * memory engine reads through the scoped repository.
 */
import { getSearchEngine, type SearchEngine } from "@/lib/search/service"
import type { SearchContext, SearchFacets } from "@/lib/search/types"

export async function listSearchFacets(
  ctx: SearchContext,
  deps: { engine?: SearchEngine } = {}
): Promise<SearchFacets> {
  const engine = deps.engine ?? (await getSearchEngine())

  return engine.facets(ctx)
}
