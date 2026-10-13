/**
 * Search capability detection (pgvector, HNSW index, pg_trgm Hebrew
 * trigrams, embedding key), feature-detected once and cached
 * (docs/parity/m6.md, A5; owner: Package A).
 *
 * STEP 0 STUB: reports every capability as unavailable.
 */
import type { SearchCapabilities } from "@/lib/search/types"

export async function getSearchCapabilities(
  opts: { refresh?: boolean } = {}
): Promise<SearchCapabilities> {
  void opts

  return {
    vector: { available: false, tableReady: false, indexReady: false, reason: "not_implemented" },
    trgm: { installed: false, hebrew: false },
    embeddingKey: null,
    checkedAt: new Date().toISOString(),
  }
}

export function resetSearchCapabilitiesForTesting(): void {}
