/**
 * Pure SQL builders for hybrid search (docs/parity/m6.md, B2; owner:
 * Package B). Each returns `{text, values}`.
 *
 * Security invariant (tested): every statement's WHERE starts with the
 * workspace match plus `meetingScopeSql(scope, 'm', values)`, before any
 * filter, ranking or limit, so ranking and fusion only ever see rows the
 * caller may read. The only interpolated values are validated literals
 * (embedding model/dimensions, numeric tuning knobs).
 */
import type { RepoScope } from "@/lib/meetings/repository"
import { meetingScopeSql } from "@/lib/meetings/visibility"
import { filterClauses } from "@/lib/search/filters"
import type { EmbeddingKey, SearchFilters } from "@/lib/search/types"

export type SqlQuery = { text: string; values: unknown[] }

export type ScopedInput = { scope: RepoScope; workspaceId: string }

export type LegInput = ScopedInput & { filters: SearchFilters; limit: number }

const MODEL_PATTERN = /^[a-z0-9._-]{1,64}$/

export class SearchSqlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SearchSqlError"
  }
}

/** Validated key (interpolated as SQL literals so the partial HNSW index matches). */
export function assertEmbeddingKey(key: EmbeddingKey): EmbeddingKey {
  if (!MODEL_PATTERN.test(key.model)) throw new SearchSqlError("Invalid embedding model")
  if (!Number.isInteger(key.dimensions) || key.dimensions < 1 || key.dimensions > 2000) {
    throw new SearchSqlError("Invalid embedding dimensions")
  }

  return key
}

function intLiteral(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new SearchSqlError(`Invalid ${name}`)

  return value
}

function limitLiteral(limit: number): number {
  return intLiteral(limit, 1, 10_000, "limit")
}

/**
 * `<ws column> = $1 and (<scope>)`: the leading predicate of every statement.
 * The scope's workspace must be the context workspace.
 */
function scopePrefix(input: ScopedInput, values: unknown[], workspaceColumns: string[]): string {
  if (input.scope.workspaceId !== input.workspaceId) {
    throw new SearchSqlError("Scope workspace does not match the search workspace")
  }

  values.push(input.workspaceId)

  const workspace = workspaceColumns.map((column) => `${column} = $${values.length}`).join(" and ")

  return `${workspace} and ${meetingScopeSql(input.scope, "m", values)}`
}

function where(prefix: string, clauses: string[]): string {
  return [prefix, ...clauses].join("\n    and ")
}

const CHUNK_FROM = "from meeting_chunks c\n  join meetings m on m.id = c.meeting_id"

/** FTS leg: `ts_rank_cd(c.tsv, q, 32)` over `to_tsquery('simple', $tq)`. */
export function buildFtsLegQuery(input: LegInput & { tsquery: string }): SqlQuery {
  const values: unknown[] = []
  const prefix = scopePrefix(input, values, ["c.workspace_id"])
  const clauses = filterClauses(input.filters, values, { chunk: true })

  values.push(input.tsquery)

  const tq = `$${values.length}`

  return {
    text:
      `select c.id, ts_rank_cd(c.tsv, q, 32) as score, m.started_at\n  ${CHUNK_FROM}\n` +
      `  cross join to_tsquery('simple', ${tq}) as q\n` +
      `  where ${where(prefix, [...clauses, "c.tsv @@ q"])}\n` +
      `  order by score desc, m.started_at desc, c.id\n  limit ${limitLiteral(input.limit)}`,
    values,
  }
}

/** `set local pg_trgm.word_similarity_threshold` (validated literal). */
export function trgmSetLocal(threshold: number): string {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new SearchSqlError("Invalid threshold")

  return `set local pg_trgm.word_similarity_threshold = ${threshold}`
}

/** Trigram leg: `word_similarity($t, c.text_norm)` with `$t <% c.text_norm`. */
export function buildTrgmLegQuery(input: LegInput & { trgm: string }): SqlQuery {
  const values: unknown[] = []
  const prefix = scopePrefix(input, values, ["c.workspace_id"])
  const clauses = filterClauses(input.filters, values, { chunk: true })

  values.push(input.trgm)

  const t = `$${values.length}`

  return {
    text:
      `select c.id, word_similarity(${t}, c.text_norm) as score, m.started_at\n  ${CHUNK_FROM}\n` +
      `  where ${where(prefix, [...clauses, `${t} <% c.text_norm`])}\n` +
      `  order by score desc, m.started_at desc, c.id\n  limit ${limitLiteral(input.limit)}`,
    values,
  }
}

/** `set local hnsw.*` for the vector leg (validated literal). */
export function vectorSetLocal(efSearch: number): string[] {
  return [
    `set local hnsw.ef_search = ${intLiteral(efSearch, 1, 1000, "ef_search")}`,
    "set local hnsw.iterative_scan = relaxed_order",
  ]
}

/** `[0.1,0.2,…]` pgvector literal; every component finite, length = dimensions. */
export function vectorLiteral(vector: number[], dimensions: number): string {
  if (vector.length !== dimensions || vector.some((value) => !Number.isFinite(value))) {
    throw new SearchSqlError("Invalid query vector")
  }

  return `[${vector.join(",")}]`
}

/**
 * Vector leg (cosine). Uses the same `embedding::vector(D)` cast and literal
 * `model`/`dimensions` as the partial HNSW index so the planner can use it.
 * `score` is the cosine similarity.
 */
export function buildVectorLegQuery(input: LegInput & { key: EmbeddingKey; vector: number[] }): SqlQuery {
  const { model, dimensions } = assertEmbeddingKey(input.key)
  const values: unknown[] = []
  const prefix = scopePrefix(input, values, ["e.workspace_id", "c.workspace_id"])
  const clauses = filterClauses(input.filters, values, { chunk: true })

  values.push(vectorLiteral(input.vector, dimensions))

  const distance = `(e.embedding::vector(${dimensions})) <=> $${values.length}::vector(${dimensions})`

  return {
    text:
      `select c.id, 1 - (${distance}) as score, m.started_at\n` +
      `  from meeting_chunk_embeddings e\n` +
      `  join meeting_chunks c on c.meeting_id = e.meeting_id and c.content_hash = e.content_hash\n` +
      `  join meetings m on m.id = e.meeting_id\n` +
      `  where ${where(prefix, [`e.model = '${model}'`, `e.dimensions = ${dimensions}`, ...clauses])}\n` +
      `  order by ${distance}\n  limit ${limitLiteral(input.limit)}`,
    values,
  }
}

const ROOMS_JSON =
  `coalesce((select json_agg(json_build_object('id', x.id, 'name', x.name) order by x.name) ` +
  `from meeting_contexts mc join contexts x on x.id = mc.context_id and x.workspace_id = m.workspace_id ` +
  `where mc.meeting_id = m.id), '[]'::json) as rooms`
const TAGS_JSON =
  `coalesce((select json_agg(t.name order by t.name) from meeting_tags mt ` +
  `join tags t on t.id = mt.tag_id and t.workspace_id = m.workspace_id where mt.meeting_id = m.id), '[]'::json) as tags`
const MEETING_COLUMNS =
  "m.title, m.started_at, m.source, m.language as meeting_language, m.meeting_type, m.duration_ms"

/** Hydration of candidate ids; re-applies the workspace and scope predicate. */
export function buildHydrateQuery(input: ScopedInput & { ids: string[] }): SqlQuery {
  const values: unknown[] = []
  const prefix = scopePrefix(input, values, ["c.workspace_id"])

  values.push(input.ids)

  return {
    text:
      `select c.id, c.workspace_id, c.meeting_id, c.kind, c.chunk_index, c.source_id, c.segment_ids, ` +
      `c.segment_start_ms, c.segment_offsets, c.overlap_count, c.speaker_ids, c.start_ms, c.end_ms, ` +
      `c.language, c.text, c.text_norm, c.text_stem, c.token_estimate, c.content_hash, c.transcript_version,\n` +
      `    ${MEETING_COLUMNS},\n    ${ROOMS_JSON},\n    ${TAGS_JSON},\n` +
      `    coalesce((select json_object_agg(s.id, coalesce(s.display_name, s.label)) from speakers s ` +
      `where s.meeting_id = m.id and s.id = any(c.speaker_ids)), '{}'::json) as speaker_names\n` +
      `  ${CHUNK_FROM}\n  where ${where(prefix, [`c.id = any($${values.length}::text[])`])}`,
    values,
  }
}

/** Meetings matching filters only (empty `q`), newest first. */
export function buildMeetingListQuery(
  input: ScopedInput & { filters: SearchFilters; limit: number; offset: number }
): SqlQuery {
  const values: unknown[] = []
  const prefix = scopePrefix(input, values, ["m.workspace_id"])
  const clauses = filterClauses(input.filters, values, { chunk: false })

  return {
    text:
      `select m.id, ${MEETING_COLUMNS},\n    ${ROOMS_JSON},\n    ${TAGS_JSON},\n    count(*) over () as total\n` +
      `  from meetings m\n  where ${where(prefix, clauses)}\n` +
      `  order by m.started_at desc, m.id\n  limit ${limitLiteral(input.limit)} offset ${intLiteral(input.offset, 0, 100_000, "offset")}`,
    values,
  }
}

/** In-scope meetings whose search index is not ready (excluding skipped). */
export function buildPendingCountQuery(input: ScopedInput & { filters: SearchFilters }): SqlQuery {
  const values: unknown[] = []
  const prefix = scopePrefix(input, values, ["m.workspace_id"])
  const clauses = filterClauses(input.filters, values, { chunk: false })

  return {
    text:
      `select count(*)::int as pending from meetings m\n` +
      `  where ${where(prefix, [...clauses, "m.search_index_state not in ('ready', 'skipped')"])}`,
    values,
  }
}

/** Own-segment texts for citation quotes, scoped through the meeting. */
export function buildSegmentTextsQuery(input: ScopedInput & { segmentIds: string[] }): SqlQuery {
  const values: unknown[] = []
  const prefix = scopePrefix(input, values, ["m.workspace_id"])

  values.push(input.segmentIds)

  return {
    text:
      `select s.id, s.text from transcript_segments s\n  join meetings m on m.id = s.meeting_id\n` +
      `  where ${where(prefix, [`s.id = any($${values.length}::text[])`])}`,
    values,
  }
}

const FACET_LIMIT = 200

/** Facet statements, each scoped to visible meetings. */
export function buildFacetQueries(input: ScopedInput): Record<
  "people" | "speakers" | "rooms" | "tags" | "meta",
  SqlQuery
> {
  const scoped = (build: (prefix: string, values: unknown[]) => string): SqlQuery => {
    const values: unknown[] = []
    const prefix = scopePrefix(input, values, ["m.workspace_id"])

    return { text: build(prefix, values), values }
  }

  return {
    people: scoped(
      (prefix) =>
        `select p.name, lower(p.email) as email, count(distinct m.id)::int as count\n` +
        `  from meeting_participants p join meetings m on m.id = p.meeting_id\n  where ${prefix}\n` +
        `  group by p.name, lower(p.email)\n  order by count desc, p.name\n  limit ${FACET_LIMIT}`
    ),
    speakers: scoped(
      (prefix) =>
        `select s.id, coalesce(s.display_name, s.label) as name\n` +
        `  from speakers s join meetings m on m.id = s.meeting_id\n` +
        `  where ${prefix}\n    and s.display_name is not null\n` +
        `  order by m.started_at desc, s.id\n  limit ${FACET_LIMIT}`
    ),
    rooms: scoped(
      (prefix) =>
        `select distinct x.id, x.name\n  from meeting_contexts mc\n  join meetings m on m.id = mc.meeting_id\n` +
        `  join contexts x on x.id = mc.context_id and x.workspace_id = m.workspace_id\n` +
        `  where ${prefix}\n  order by x.name\n  limit ${FACET_LIMIT}`
    ),
    tags: scoped(
      (prefix) =>
        `select distinct t.name\n  from meeting_tags mt\n  join meetings m on m.id = mt.meeting_id\n` +
        `  join tags t on t.id = mt.tag_id and t.workspace_id = m.workspace_id\n` +
        `  where ${prefix}\n  order by t.name\n  limit ${FACET_LIMIT}`
    ),
    meta: scoped(
      (prefix) =>
        `select array_remove(array_agg(distinct m.language), null) as languages,\n` +
        `    array_remove(array_agg(distinct m.meeting_type), null) as meeting_types,\n` +
        `    array_remove(array_agg(distinct m.source), null) as sources\n` +
        `  from meetings m\n  where ${prefix}`
    ),
  }
}
