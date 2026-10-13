/**
 * Optional pgvector DDL: the embeddings table and one partial HNSW index
 * per embedding key (docs/parity/m6.md, A5; owner: Package A). The default
 * key's statements are kept in sync with the DO block of
 * db/migrations/025_search_ask.sql by a static test.
 *
 * The model and dimensions become SQL literals (a partial index only
 * matches literal predicates), so every entry point validates the key.
 */
import { assertValidEmbeddingKey } from "@/lib/ai/embeddings/config"
import type { Queryable } from "@/lib/db/client"
import type { EmbeddingKey } from "@/lib/search/types"

/** pgvector 0.8 brings iterative index scans for filtered HNSW queries. */
export const MIN_PGVECTOR_VERSION: readonly [number, number] = [0, 8]

/** `idx_mce_hnsw_<model with non-alphanumerics as _>_<dimensions>`. */
export function vectorIndexName(key: EmbeddingKey): string {
  const valid = assertValidEmbeddingKey(key)

  return `idx_mce_hnsw_${valid.model.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_${valid.dimensions}`
}

/** `where model = '<m>' and dimensions = <d>` with validated literals. */
export function embeddingKeyPredicate(key: EmbeddingKey, alias?: string): string {
  const valid = assertValidEmbeddingKey(key)
  const prefix = alias ? `${alias}.` : ""

  return `${prefix}model = '${valid.model}' and ${prefix}dimensions = ${valid.dimensions}`
}

export const EMBEDDINGS_TABLE_DDL = `create table if not exists meeting_chunk_embeddings (
      workspace_id text not null references workspaces(id) on delete cascade,
      meeting_id text not null references meetings(id) on delete cascade,
      content_hash text not null,
      model text not null,
      dimensions smallint not null check (dimensions between 1 and 2000),
      embedding vector not null,
      created_at timestamptz not null default now(),
      primary key (meeting_id, content_hash, model, dimensions)
    )`

export const EMBEDDINGS_WS_INDEX_DDL =
  "create index if not exists idx_mce_ws on meeting_chunk_embeddings (workspace_id, model, dimensions)"

export function vectorIndexStatement(key: EmbeddingKey): string {
  const valid = assertValidEmbeddingKey(key)

  return `create index if not exists ${vectorIndexName(valid)} on meeting_chunk_embeddings
      using hnsw ((embedding::vector(${valid.dimensions})) vector_cosine_ops) with (m = 16, ef_construction = 64)
      where ${embeddingKeyPredicate(valid)}`
}

/** The statements of 025's vector block, plus the partial index for `key`. */
export function vectorSetupStatements(key: EmbeddingKey): string[] {
  return [
    "create extension if not exists vector",
    EMBEDDINGS_TABLE_DDL,
    EMBEDDINGS_WS_INDEX_DDL,
    vectorIndexStatement(key),
  ]
}

/** `"0.8.1"` → `[0, 8, 1]`; tolerates suffixes such as `0.8.0-dev`. */
export function parseExtensionVersion(version: string | null | undefined): number[] | undefined {
  const parts = version?.split("-")[0]?.split(".").map(Number)

  return parts && parts.length && parts.every(Number.isFinite) ? parts : undefined
}

export function isSupportedPgvectorVersion(version: string | null | undefined): boolean {
  const parts = parseExtensionVersion(version)

  if (!parts) return false
  for (let index = 0; index < MIN_PGVECTOR_VERSION.length; index += 1) {
    const value = parts[index] ?? 0

    if (value !== MIN_PGVECTOR_VERSION[index]) return value > MIN_PGVECTOR_VERSION[index]
  }

  return true
}

type Row = { available?: string | null; installed?: string | null }

/**
 * Installs pgvector, the embeddings table and the partial HNSW index for
 * `key` when pgvector ≥ 0.8 is available (idempotent). Without it, returns
 * the reason and changes nothing.
 */
export async function ensureVectorSupport(
  db: Queryable,
  key: EmbeddingKey
): Promise<{ enabled: boolean; reason?: string }> {
  const statements = vectorSetupStatements(key)
  const result = await db.query(
    `select
       (select default_version from pg_available_extensions where name = 'vector') as available,
       (select extversion from pg_extension where extname = 'vector') as installed`
  )
  const row = (result.rows[0] ?? {}) as Row
  const version = row.installed ?? row.available

  if (!version) return { enabled: false, reason: "vector_unavailable" }
  if (!isSupportedPgvectorVersion(version)) return { enabled: false, reason: "vector_too_old" }

  for (const statement of statements) await db.query(statement)

  return { enabled: true }
}

/**
 * `search:vector-setup --gc`: deletes vectors of other keys for meetings
 * already indexed with `activeKey` (re-keyed meetings). Returns the count;
 * 0 when the embeddings table does not exist.
 */
export async function gcStaleEmbeddings(db: Queryable, activeKey: EmbeddingKey): Promise<number> {
  const valid = assertValidEmbeddingKey(activeKey)
  const table = await db.query("select to_regclass('meeting_chunk_embeddings') is not null as ready")

  if (!(table.rows[0] as { ready?: boolean } | undefined)?.ready) return 0

  const result = await db.query(
    `with removed as (
       delete from meeting_chunk_embeddings e
       where not (${embeddingKeyPredicate(valid, "e")})
         and exists (
           select 1 from meetings m
           where m.id = e.meeting_id and m.workspace_id = e.workspace_id and m.search_embedding_key = $1
         )
       returning 1
     )
     select count(*)::int as count from removed`,
    [`${valid.model}:${valid.dimensions}`]
  )

  return Number((result.rows[0] as { count?: unknown } | undefined)?.count ?? 0)
}
