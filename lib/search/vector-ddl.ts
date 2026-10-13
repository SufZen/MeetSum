/**
 * Optional pgvector DDL (embeddings table and one partial HNSW index per
 * embedding key). Kept in sync with db/migrations/025_search_ask.sql by a
 * static test (docs/parity/m6.md, A5; owner: Package A).
 *
 * STEP 0 STUB: no statements; vector support is never enabled.
 */
import type { Queryable } from "@/lib/db/client"
import type { EmbeddingKey } from "@/lib/search/types"

export function vectorSetupStatements(key: EmbeddingKey): string[] {
  void key

  return []
}

/** `idx_mce_hnsw_<model with non-alphanumerics as _>_<dimensions>`. */
export function vectorIndexName(key: EmbeddingKey): string {
  return `idx_mce_hnsw_${key.model.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_${key.dimensions}`
}

export async function ensureVectorSupport(
  db: Queryable,
  key: EmbeddingKey
): Promise<{ enabled: boolean; reason?: string }> {
  void db
  void key

  return { enabled: false, reason: "not_implemented" }
}
