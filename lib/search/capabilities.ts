/**
 * Search capability detection (docs/parity/m6.md, A5; owner: Package A):
 * pgvector ≥ 0.8 installed, the embeddings table, the partial HNSW index of
 * the active key, pg_trgm and whether it yields Hebrew trigrams (database
 * locale). Detected once and cached for five minutes; detection never
 * throws (a failure reports everything unavailable, so search runs
 * lexical).
 *
 * - `vector.available`: the extension is installed at ≥ 0.8.
 * - `vector.tableReady`: …and `meeting_chunk_embeddings` exists (the
 *   indexer may write vectors).
 * - `vector.indexReady`: …and the HNSW index for the active key exists (the
 *   vector leg may run).
 */
import { getActiveEmbeddingKey } from "@/lib/ai/embeddings"
import type { Queryable } from "@/lib/db/client"
import { isSupportedPgvectorVersion } from "@/lib/search/vector-ddl"
import { formatEmbeddingKey, type EmbeddingKey, type SearchCapabilities } from "@/lib/search/types"

const CACHE_TTL_MS = 5 * 60 * 1000

export type VectorUnavailableReason =
  | "no_database"
  | "detection_failed"
  | "vector_unavailable"
  | "vector_too_old"
  | "vector_not_installed"
  | "table_missing"
  | "no_embedding_provider"
  | "index_missing"

type DetectRow = {
  available?: string | null
  installed?: string | null
  table_ready?: boolean | null
  trgm?: string | null
}

function unavailable(reason: VectorUnavailableReason, embeddingKey: EmbeddingKey | null): SearchCapabilities {
  return {
    vector: { available: false, tableReady: false, indexReady: false, reason },
    trgm: { installed: false, hebrew: false },
    embeddingKey,
    checkedAt: new Date().toISOString(),
  }
}

/** True when an index definition is the partial HNSW index of `key`. */
export function indexMatchesKey(indexdef: string, key: EmbeddingKey): boolean {
  const def = indexdef.toLowerCase()
  const model = key.model.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

  return (
    /using hnsw/.test(def) &&
    new RegExp(`model\\s*=\\s*'${model}'`).test(def) &&
    new RegExp(`dimensions\\s*=\\s*${key.dimensions}(?![0-9])`).test(def)
  )
}

/** Feature-detects the capabilities on `db` for the active key (null = no provider). */
export async function detectSearchCapabilities(
  db: Queryable,
  embeddingKey: EmbeddingKey | null
): Promise<SearchCapabilities> {
  try {
    const result = await db.query(
      `select
         (select default_version from pg_available_extensions where name = 'vector') as available,
         (select extversion from pg_extension where extname = 'vector') as installed,
         to_regclass('meeting_chunk_embeddings') is not null as table_ready,
         (select extversion from pg_extension where extname = 'pg_trgm') as trgm`
    )
    const row = (result.rows[0] ?? {}) as DetectRow
    let hebrew = false

    if (row.trgm) {
      const trigrams = await db.query(
        "select coalesce(array_length(show_trgm('תקציב'), 1), 0) as count"
      )

      hebrew = Number((trigrams.rows[0] as { count?: unknown } | undefined)?.count ?? 0) > 0
    }

    const vector: SearchCapabilities["vector"] = {
      available: false,
      ...(row.installed ? { installedVersion: row.installed } : {}),
      tableReady: false,
      indexReady: false,
    }

    if (!row.installed && !row.available) vector.reason = "vector_unavailable"
    else if (!isSupportedPgvectorVersion(row.installed ?? row.available)) vector.reason = "vector_too_old"
    else if (!row.installed) vector.reason = "vector_not_installed"
    else {
      vector.available = true
      if (!row.table_ready) vector.reason = "table_missing"
      else {
        vector.tableReady = true
        if (!embeddingKey) vector.reason = "no_embedding_provider"
        else {
          const indexes = await db.query(
            "select indexdef from pg_indexes where tablename = 'meeting_chunk_embeddings'"
          )
          const ready = indexes.rows.some((entry) =>
            indexMatchesKey(String((entry as { indexdef?: unknown }).indexdef ?? ""), embeddingKey)
          )

          vector.indexReady = ready
          if (!ready) vector.reason = "index_missing"
        }
      }
    }

    return {
      vector,
      trgm: { installed: Boolean(row.trgm), hebrew },
      embeddingKey,
      checkedAt: new Date().toISOString(),
    }
  } catch {
    return unavailable("detection_failed", embeddingKey)
  }
}

let cached: { value: SearchCapabilities; expiresAt: number; keyId: string } | undefined
let inflight: Promise<SearchCapabilities> | undefined

export async function getSearchCapabilities(opts: { refresh?: boolean } = {}): Promise<SearchCapabilities> {
  const embeddingKey = getActiveEmbeddingKey()

  if (process.env.MEETSUM_STORAGE !== "postgres") return unavailable("no_database", embeddingKey)

  const keyId = embeddingKey ? formatEmbeddingKey(embeddingKey) : ""

  if (!opts.refresh && cached && cached.expiresAt > Date.now() && cached.keyId === keyId) return cached.value
  if (!opts.refresh && inflight) return inflight

  inflight = (async () => {
    try {
      const { getDatabasePool } = await import("@/lib/db/client")
      const value = await detectSearchCapabilities(getDatabasePool(), embeddingKey)

      cached = { value, expiresAt: Date.now() + CACHE_TTL_MS, keyId }
      return value
    } catch {
      return unavailable("detection_failed", embeddingKey)
    } finally {
      inflight = undefined
    }
  })()

  return inflight
}

export function resetSearchCapabilitiesForTesting(): void {
  cached = undefined
  inflight = undefined
}

/** One log line describing the capabilities; for the worker and instrumentation. */
export function describeSearchCapabilities(caps: SearchCapabilities): string {
  const vector = caps.vector.indexReady
    ? "vector=ready"
    : `vector=off(${caps.vector.reason ?? (caps.vector.tableReady ? "index_missing" : "unavailable")})`
  const trgm = caps.trgm.installed ? (caps.trgm.hebrew ? "trgm=hebrew" : "trgm=no_hebrew") : "trgm=missing"
  const key = caps.embeddingKey ? formatEmbeddingKey(caps.embeddingKey) : "none"
  const mode = caps.vector.indexReady && caps.embeddingKey ? "hybrid" : "lexical"

  return `[search] capabilities: mode=${mode} ${vector} ${trgm} embedding=${key}`
}

/** Detects and logs the capabilities once; never throws. */
export async function warmSearchCapabilities(log: Pick<Console, "log"> = console): Promise<void> {
  try {
    log.log(describeSearchCapabilities(await getSearchCapabilities({ refresh: true })))
  } catch {
    // Startup logging must never fail the process.
  }
}
