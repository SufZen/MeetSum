/**
 * Postgres search engine (docs/parity/m6.md, B2/B5; owner: Package B).
 *
 * Runs the scoped SQL legs from `sql.ts` in one transaction (so `set local`
 * applies): vector (only when pgvector + the active key's HNSW index are
 * ready and a query vector exists), FTS, and trigram (only when pg_trgm
 * yields Hebrew trigrams). The vector leg runs under a savepoint: a failure
 * there degrades to lexical instead of failing the search.
 */
import { getDatabasePool, type Queryable } from "@/lib/db/client"
import { withTransaction } from "@/lib/meetings/postgres-repository"
import { getSearchCapabilities } from "@/lib/search/capabilities"
import type { LegName, LegRow, Legs } from "@/lib/search/rrf"
import type { HydratedChunk, SearchEngine, SearchMeetingMeta } from "@/lib/search/service"
import {
  buildFacetQueries,
  buildFtsLegQuery,
  buildHydrateQuery,
  buildMeetingListQuery,
  buildPendingCountQuery,
  buildSegmentTextsQuery,
  buildTrgmLegQuery,
  buildVectorLegQuery,
  trgmSetLocal,
  vectorSetLocal,
  type ScopedInput,
} from "@/lib/search/sql"
import { TEXT_LANGUAGES } from "@/lib/search/filters"
import type { ChunkKind, SearchCapabilities, SearchContext, TextLanguage } from "@/lib/search/types"

export type PgEngineOptions = {
  client?: Queryable
  capabilities?: () => Promise<SearchCapabilities>
}

type Row = Record<string, unknown>

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString()

  return typeof value === "string" ? value : String(value ?? "")
}

function num(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined

  const parsed = Number(value)

  return Number.isFinite(parsed) ? parsed : undefined
}

function json<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T
    } catch {
      return fallback
    }
  }

  return value as T
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : []
}

function numbers(value: unknown): number[] {
  return Array.isArray(value) ? value.map(Number) : []
}

function legRows(rows: unknown[]): LegRow[] {
  return (rows as Row[]).map((row) => ({
    id: String(row.id),
    score: Number(row.score) || 0,
    startedAt: iso(row.started_at),
  }))
}

export function mapMeetingMeta(row: Row, idColumn = "id"): SearchMeetingMeta {
  const meetingType = row.meeting_type as string | null
  const durationMs = num(row.duration_ms)
  const language = (row.meeting_language ?? row.language) as string | null

  return {
    id: String(row[idColumn]),
    title: String(row.title ?? ""),
    startedAt: iso(row.started_at),
    source: String(row.source ?? ""),
    ...(language ? { language } : {}),
    ...(meetingType ? { meetingType } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    tags: json<string[]>(row.tags, []),
    rooms: json<{ id: string; name: string }[]>(row.rooms, []),
  }
}

export function mapHydratedRow(row: Row): HydratedChunk {
  const startMs = num(row.start_ms)
  const endMs = num(row.end_ms)
  const language = row.language as TextLanguage | null

  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    meetingId: String(row.meeting_id),
    kind: row.kind as ChunkKind,
    chunkIndex: Number(row.chunk_index) || 0,
    ...(row.source_id ? { sourceId: String(row.source_id) } : {}),
    segmentIds: strings(row.segment_ids),
    segmentStartMs: numbers(row.segment_start_ms),
    segmentOffsets: numbers(row.segment_offsets),
    overlapCount: Number(row.overlap_count) || 0,
    speakerIds: strings(row.speaker_ids),
    ...(startMs !== undefined ? { startMs } : {}),
    ...(endMs !== undefined ? { endMs } : {}),
    ...(language ? { language } : {}),
    text: String(row.text ?? ""),
    textNorm: String(row.text_norm ?? ""),
    textStem: String(row.text_stem ?? ""),
    tokenEstimate: Number(row.token_estimate) || 0,
    contentHash: String(row.content_hash ?? ""),
    transcriptVersion: Number(row.transcript_version) || 0,
    meeting: mapMeetingMeta(row, "meeting_id"),
    speakerNames: json<Record<string, string>>(row.speaker_names, {}),
  }
}

function scoped(ctx: SearchContext): ScopedInput {
  return { scope: ctx.scope, workspaceId: ctx.workspaceId }
}

export function createPgSearchEngine(options: PgEngineOptions = {}): SearchEngine {
  const client = () => options.client ?? getDatabasePool()
  const capabilities = options.capabilities ?? (() => getSearchCapabilities())

  return {
    kind: "pg",

    async capabilities() {
      const caps = await capabilities()

      return {
        vector: caps.vector.available && caps.vector.tableReady && caps.vector.indexReady,
        trgm: caps.trgm.installed && caps.trgm.hebrew,
        embeddingKey: caps.embeddingKey,
      }
    },

    async runLegs(ctx, request) {
      const legs: Legs = {}
      const failed: LegName[] = []
      const base = { ...scoped(ctx), filters: request.filters }

      await withTransaction(client(), async (tx) => {
        if (request.vector) {
          await tx.query("savepoint search_vector_leg")

          try {
            for (const statement of vectorSetLocal(request.config.efSearch)) await tx.query(statement)

            const query = buildVectorLegQuery({
              ...base,
              limit: request.config.vectorK,
              key: request.vector.key,
              vector: request.vector.values,
            })

            legs.vector = legRows((await tx.query(query.text, query.values)).rows).sort((a, b) => b.score - a.score)
            await tx.query("release savepoint search_vector_leg")
          } catch {
            failed.push("vector")
            await tx.query("rollback to savepoint search_vector_leg")
          }
        }

        if (request.tsquery) {
          const query = buildFtsLegQuery({ ...base, limit: request.config.ftsK, tsquery: request.tsquery })

          legs.fts = legRows((await tx.query(query.text, query.values)).rows)
        }

        if (request.trgm) {
          await tx.query(trgmSetLocal(request.config.trgmThreshold))

          const query = buildTrgmLegQuery({ ...base, limit: request.config.trgmK, trgm: request.trgm })

          legs.trgm = legRows((await tx.query(query.text, query.values)).rows)
        }
      })

      return { legs, failed }
    },

    async hydrate(ctx, ids) {
      if (!ids.length) return []

      const query = buildHydrateQuery({ ...scoped(ctx), ids })

      return ((await client().query(query.text, query.values)).rows as Row[]).map(mapHydratedRow)
    },

    async listMeetings(ctx, filters, page) {
      const query = buildMeetingListQuery({ ...scoped(ctx), filters, ...page })
      const rows = (await client().query(query.text, query.values)).rows as Row[]

      return { meetings: rows.map((row) => mapMeetingMeta(row)), total: Number(rows[0]?.total ?? 0) }
    },

    async countPending(ctx, filters) {
      const query = buildPendingCountQuery({ ...scoped(ctx), filters })
      const row = (await client().query(query.text, query.values)).rows[0] as Row | undefined

      return Number(row?.pending ?? 0)
    },

    async segmentTexts(ctx, segmentIds) {
      if (!segmentIds.length) return {}

      const query = buildSegmentTextsQuery({ ...scoped(ctx), segmentIds })
      const rows = (await client().query(query.text, query.values)).rows as Row[]

      return Object.fromEntries(rows.map((row) => [String(row.id), String(row.text ?? "")]))
    },

    async facets(ctx) {
      const queries = buildFacetQueries(scoped(ctx))
      const run = async (name: keyof typeof queries) =>
        (await client().query(queries[name].text, queries[name].values)).rows as Row[]
      const [people, speakers, rooms, tags, meta] = await Promise.all([
        run("people"),
        run("speakers"),
        run("rooms"),
        run("tags"),
        run("meta"),
      ])
      const metaRow = meta[0] ?? {}

      return {
        people: people.map((row) => ({
          name: String(row.name ?? ""),
          ...(row.email ? { email: String(row.email) } : {}),
          count: Number(row.count) || 0,
        })),
        speakers: speakers.map((row) => ({ id: String(row.id), name: String(row.name ?? "") })),
        rooms: rooms.map((row) => ({ id: String(row.id), name: String(row.name ?? "") })),
        tags: tags.map((row) => String(row.name)),
        languages: strings(metaRow.languages).filter((value): value is TextLanguage =>
          TEXT_LANGUAGES.includes(value as TextLanguage)
        ),
        meetingTypes: strings(metaRow.meeting_types).sort(),
        sources: strings(metaRow.sources).sort(),
      }
    },
  }
}
