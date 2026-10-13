/**
 * SQL for the search index (docs/parity/m6.md, A6; owner: Package A).
 * Hand-written statements; every one is scoped by `workspace_id`. The
 * embedding model and dimensions are validated and written as literals
 * (the partial HNSW index of a key only matches literal predicates).
 *
 * `writeIndex` runs in one transaction:
 *   1. `select transcript_version … for update` (a version change since the
 *      meeting was loaded rolls back with a retryable error);
 *   2. delete the meeting's chunks, multi-row insert the new ones;
 *   3. insert new vectors (`$n::vector`, `on conflict do nothing`);
 *   4. delete active-key vectors whose hash left the chunk set, and every
 *      other key's vectors once the active key covers all chunks;
 *   5. mark the meeting `ready` with mode, key, meeting type and version.
 */
import { createHash } from "node:crypto"

import { assertValidEmbeddingKey } from "@/lib/ai/embeddings/config"
import type { Queryable } from "@/lib/db/client"
import { embeddingKeyPredicate } from "@/lib/search/vector-ddl"
import type { ChunkDraft, EmbeddingKey } from "@/lib/search/types"

/** The transcript changed while indexing; BullMQ retries the job. */
export class IndexVersionConflictError extends Error {
  readonly retryable = true

  constructor(readonly expected: number, readonly actual: number) {
    super(`transcript_version changed while indexing (${expected} → ${actual})`)
    this.name = "IndexVersionConflictError"
  }
}

/** The meeting no longer exists in the workspace (deleted while indexing). */
export class IndexMeetingMissingError extends Error {
  constructor(meetingId: string) {
    super(`Meeting not found while indexing: ${meetingId}`)
    this.name = "IndexMeetingMissingError"
  }
}

export type IndexVector = { contentHash: string; embedding: number[] }

export type IndexWrite = {
  workspaceId: string
  meetingId: string
  /** `meetings.transcript_version` the chunks were built from. */
  expectedVersion: number
  chunks: ChunkDraft[]
  /** Active key; null when no provider is configured. */
  key: EmbeddingKey | null
  /** `meeting_chunk_embeddings` exists (vector cleanup and inserts allowed). */
  vectorTable: boolean
  vectors: IndexVector[]
  /** Every chunk hash has an active-key vector: other keys' rows are removed. */
  coversAllChunks: boolean
  mode: "hybrid" | "lexical"
  meetingType: string | null
  /** When indexing started: edits requested later are caught by the sweeper. */
  startedAt: Date
}

const CHUNK_COLUMNS = [
  "id",
  "workspace_id",
  "meeting_id",
  "kind",
  "chunk_index",
  "source_id",
  "segment_ids",
  "segment_start_ms",
  "segment_offsets",
  "overlap_count",
  "speaker_ids",
  "start_ms",
  "end_ms",
  "language",
  "text",
  "text_norm",
  "text_stem",
  "token_estimate",
  "content_hash",
  "transcript_version",
] as const

const CHUNK_CASTS: Partial<Record<(typeof CHUNK_COLUMNS)[number], string>> = {
  segment_ids: "::text[]",
  segment_start_ms: "::integer[]",
  segment_offsets: "::integer[]",
  speaker_ids: "::text[]",
}

const CHUNK_ROWS_PER_INSERT = 200
const VECTOR_ROWS_PER_INSERT = 100
const MAX_ERROR_LENGTH = 500

type PoolLike = Queryable & { connect?: () => Promise<Queryable & { release: () => void }> }

/** BEGIN/COMMIT on a dedicated connection for a pg Pool; fakes without `connect` run inline. */
export async function runInTransaction<T>(db: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const pool = db as PoolLike

  if (typeof pool.connect !== "function") return fn(db)

  const connection = await pool.connect()

  try {
    await connection.query("begin")
    const result = await fn(connection)

    await connection.query("commit")
    return result
  } catch (error) {
    await connection.query("rollback").catch(() => undefined)
    throw error
  } finally {
    connection.release()
  }
}

/** Deterministic, content-bound chunk id. */
export function chunkId(meetingId: string, chunk: Pick<ChunkDraft, "kind" | "chunkIndex" | "contentHash">): string {
  const digest = createHash("sha256")
    .update(`${meetingId}\0${chunk.kind}\0${chunk.chunkIndex}\0${chunk.contentHash}`)
    .digest("hex")
    .slice(0, 24)

  return `chk_${digest}`
}

/** pgvector text literal; rejects non-finite values. */
export function toVectorLiteral(embedding: number[]): string {
  if (!embedding.length || !embedding.every(Number.isFinite)) throw new Error("Invalid embedding vector")

  return `[${embedding.join(",")}]`
}

function chunkRow(write: IndexWrite, chunk: ChunkDraft): unknown[] {
  return [
    chunkId(write.meetingId, chunk),
    write.workspaceId,
    write.meetingId,
    chunk.kind,
    chunk.chunkIndex,
    chunk.sourceId ?? null,
    chunk.segmentIds,
    chunk.segmentStartMs.map((value) => Math.round(value)),
    chunk.segmentOffsets,
    chunk.overlapCount,
    chunk.speakerIds,
    chunk.startMs === undefined ? null : Math.round(chunk.startMs),
    chunk.endMs === undefined ? null : Math.round(chunk.endMs),
    chunk.language ?? null,
    chunk.text,
    chunk.textNorm,
    chunk.textStem,
    chunk.tokenEstimate,
    chunk.contentHash,
    write.expectedVersion,
  ]
}

async function insertChunks(tx: Queryable, write: IndexWrite) {
  for (let start = 0; start < write.chunks.length; start += CHUNK_ROWS_PER_INSERT) {
    const rows = write.chunks.slice(start, start + CHUNK_ROWS_PER_INSERT)
    const values: unknown[] = []
    const tuples = rows.map((chunk) => {
      const row = chunkRow(write, chunk)
      const placeholders = row.map((value, column) => {
        values.push(value)
        return `$${values.length}${CHUNK_CASTS[CHUNK_COLUMNS[column]] ?? ""}`
      })

      return `(${placeholders.join(", ")})`
    })

    await tx.query(`insert into meeting_chunks (${CHUNK_COLUMNS.join(", ")}) values ${tuples.join(", ")}`, values)
  }
}

async function insertVectors(tx: Queryable, write: IndexWrite, key: EmbeddingKey) {
  const valid = assertValidEmbeddingKey(key)

  for (let start = 0; start < write.vectors.length; start += VECTOR_ROWS_PER_INSERT) {
    const rows = write.vectors.slice(start, start + VECTOR_ROWS_PER_INSERT)
    const values: unknown[] = [write.workspaceId, write.meetingId]
    const tuples = rows.map((vector) => {
      if (vector.embedding.length !== valid.dimensions) throw new Error("Embedding dimensions do not match the key")
      values.push(vector.contentHash, toVectorLiteral(vector.embedding))

      return `($1, $2, $${values.length - 1}, '${valid.model}', ${valid.dimensions}, $${values.length}::vector)`
    })

    await tx.query(
      `insert into meeting_chunk_embeddings (workspace_id, meeting_id, content_hash, model, dimensions, embedding)
       values ${tuples.join(", ")}
       on conflict do nothing`,
      values
    )
  }
}

export type IndexStore = {
  /** Content hashes of the meeting that already have a vector for `key`. */
  existingHashes(workspaceId: string, meetingId: string, key: EmbeddingKey): Promise<Set<string>>
  writeIndex(write: IndexWrite): Promise<void>
  /** Nothing to index: drop stale chunks and mark `skipped` at the current version. */
  markSkipped(workspaceId: string, meetingId: string): Promise<void>
  /** Indexing failed; the sweeper retries `failed` meetings at most every 6 h. */
  markFailed(workspaceId: string, meetingId: string, error: string): Promise<void>
}

export function createIndexStore(db: Queryable): IndexStore {
  return {
    async existingHashes(workspaceId, meetingId, key) {
      const valid = assertValidEmbeddingKey(key)
      const result = await db.query(
        `select content_hash from meeting_chunk_embeddings
         where meeting_id = $1 and workspace_id = $2 and model = $3 and dimensions = $4`,
        [meetingId, workspaceId, valid.model, valid.dimensions]
      )

      return new Set(result.rows.map((row) => String((row as { content_hash: unknown }).content_hash)))
    },

    async writeIndex(write) {
      const key = write.key ? assertValidEmbeddingKey(write.key) : null

      await runInTransaction(db, async (tx) => {
        const locked = await tx.query(
          "select transcript_version from meetings where id = $1 and workspace_id = $2 for update",
          [write.meetingId, write.workspaceId]
        )
        const row = locked.rows[0] as { transcript_version?: number | string | null } | undefined

        if (!row) throw new IndexMeetingMissingError(write.meetingId)
        const actual = Number(row.transcript_version ?? 0)

        if (actual !== write.expectedVersion) throw new IndexVersionConflictError(write.expectedVersion, actual)

        await tx.query("delete from meeting_chunks where meeting_id = $1 and workspace_id = $2", [
          write.meetingId,
          write.workspaceId,
        ])
        await insertChunks(tx, write)

        if (write.vectorTable && key) {
          if (write.vectors.length) await insertVectors(tx, write, key)
          await tx.query(
            `delete from meeting_chunk_embeddings
             where meeting_id = $1 and workspace_id = $2 and ${embeddingKeyPredicate(key)}
               and not (content_hash = any($3::text[]))`,
            [write.meetingId, write.workspaceId, [...new Set(write.chunks.map((chunk) => chunk.contentHash))]]
          )
          if (write.coversAllChunks) {
            await tx.query(
              `delete from meeting_chunk_embeddings
               where meeting_id = $1 and workspace_id = $2 and not (${embeddingKeyPredicate(key)})`,
              [write.meetingId, write.workspaceId]
            )
          }
        }

        await tx.query(
          `update meetings set
             search_index_state = 'ready',
             search_index_mode = $3,
             search_embedding_key = $4,
             meeting_type = $5,
             search_indexed_at = $6,
             search_indexed_version = $7,
             search_index_error = null
           where id = $1 and workspace_id = $2`,
          [
            write.meetingId,
            write.workspaceId,
            write.mode,
            write.mode === "hybrid" && key ? `${key.model}:${key.dimensions}` : null,
            write.meetingType,
            write.startedAt.toISOString(),
            write.expectedVersion,
          ]
        )
      })
    },

    async markSkipped(workspaceId, meetingId) {
      await runInTransaction(db, async (tx) => {
        await tx.query("delete from meeting_chunks where meeting_id = $1 and workspace_id = $2", [meetingId, workspaceId])
        await tx.query(
          `update meetings set
             search_index_state = 'skipped',
             search_index_mode = null,
             search_embedding_key = null,
             search_indexed_at = now(),
             search_indexed_version = transcript_version,
             search_index_error = null
           where id = $1 and workspace_id = $2`,
          [meetingId, workspaceId]
        )
      })
    },

    async markFailed(workspaceId, meetingId, error) {
      // search_indexed_at doubles as the last attempt (6 h retry window).
      await db.query(
        `update meetings set
           search_index_state = 'failed',
           search_index_error = $3,
           search_indexed_at = now()
         where id = $1 and workspace_id = $2`,
        [meetingId, workspaceId, error.slice(0, MAX_ERROR_LENGTH)]
      )
    },
  }
}
