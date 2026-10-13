/**
 * Hybrid search (vector + FTS + trigram, weighted RRF, visibility before
 * ranking). docs/parity/m6.md, B5; owner: Package B.
 *
 * Two engines share one interface: `pg-engine` (MEETSUM_STORAGE=postgres;
 * scoped SQL legs over `meeting_chunks`) and `memory-engine` (demo/in-memory
 * storage and the eval; chunks visible meetings on the fly). Both only ever
 * see rows the caller may read: the pg legs carry `meetingScopeSql` in every
 * WHERE, the memory engine reads through the caller's scoped repository.
 */
import { embedQuery } from "@/lib/ai/embeddings"
import type { EmbeddingTask } from "@/lib/ai/embeddings/types"
import { cursorBinding, decodeCursor, encodeCursor } from "@/lib/search/cursor"
import { clampSearchParams, hasFilters } from "@/lib/search/filters"
import { normalizeQuery } from "@/lib/search/hebrew-normalize"
import { buildTsQuery, trgmQuery } from "@/lib/search/query"
import { DEFAULT_RRF_K, fuse, parseWeights, type FusedCandidate, type LegName, type Legs, type LegWeights } from "@/lib/search/rrf"
import { buildSnippet, pickCitationSegment } from "@/lib/search/snippet"
import type {
  EmbeddingKey,
  MeetingChunk,
  NormalizedQuery,
  SearchContext,
  SearchFacets,
  SearchFilters,
  SearchHit,
  SearchMeetingGroup,
  SearchMode,
  SearchParams,
  SearchResponse,
} from "@/lib/search/types"

export type SearchMeetingMeta = SearchMeetingGroup["meeting"]

/** A scoped, hydrated chunk plus its meeting metadata. */
export type HydratedChunk = MeetingChunk & {
  meeting: SearchMeetingMeta
  /** speaker id → display name for `speakerIds`. */
  speakerNames: Record<string, string>
}

export type SearchConfig = {
  vectorK: number
  ftsK: number
  trgmK: number
  rrfK: number
  weights: LegWeights
  efSearch: number
  trgmThreshold: number
  maxCandidates: number
}

export type LegRequest = {
  nq: NormalizedQuery
  tsquery: string | null
  trgm: string | null
  filters: SearchFilters
  vector: { key: EmbeddingKey; values: number[] } | null
  config: SearchConfig
}

export type EngineCapabilities = {
  /** Vector leg usable (pg: pgvector ready with the active key's index). */
  vector: boolean
  /** Trigram leg usable (pg: pg_trgm yields Hebrew trigrams). */
  trgm: boolean
  embeddingKey: EmbeddingKey | null
}

export type SearchEngine = {
  kind: "pg" | "memory"
  capabilities(ctx: SearchContext): Promise<EngineCapabilities>
  /** Engine-specific query embedding (eval replay); default `embedQuery`. */
  queryVector?(ctx: SearchContext, text: string, task: EmbeddingTask): Promise<number[] | null>
  runLegs(ctx: SearchContext, request: LegRequest): Promise<{ legs: Legs; failed?: LegName[] }>
  hydrate(ctx: SearchContext, ids: string[]): Promise<HydratedChunk[]>
  listMeetings(
    ctx: SearchContext,
    filters: SearchFilters,
    page: { limit: number; offset: number }
  ): Promise<{ meetings: SearchMeetingMeta[]; total: number }>
  countPending(ctx: SearchContext, filters: SearchFilters): Promise<number | undefined>
  segmentTexts(ctx: SearchContext, segmentIds: string[]): Promise<Record<string, string>>
  facets(ctx: SearchContext): Promise<SearchFacets>
}

type Env = Record<string, string | undefined>

function envInt(env: Env, name: string, fallback: number, min: number, max: number): number {
  const value = Number(env[name])

  return Number.isInteger(value) && value >= min && value <= max ? value : fallback
}

function envFloat(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]
  const value = raw === undefined || raw === "" ? Number.NaN : Number(raw)

  return Number.isFinite(value) && value >= min && value <= max ? value : fallback
}

export function searchConfig(env: Env = process.env): SearchConfig {
  return {
    vectorK: envInt(env, "MEETSUM_SEARCH_VECTOR_K", 100, 1, 1000),
    ftsK: envInt(env, "MEETSUM_SEARCH_FTS_K", 100, 1, 1000),
    trgmK: envInt(env, "MEETSUM_SEARCH_TRGM_K", 50, 1, 1000),
    rrfK: envInt(env, "MEETSUM_SEARCH_RRF_K", DEFAULT_RRF_K, 1, 1000),
    weights: parseWeights(env.MEETSUM_SEARCH_WEIGHTS),
    efSearch: envInt(env, "MEETSUM_SEARCH_HNSW_EF_SEARCH", 100, 1, 1000),
    trgmThreshold: envFloat(env, "MEETSUM_SEARCH_TRGM_THRESHOLD", 0.45, 0, 1),
    maxCandidates: envInt(env, "MEETSUM_SEARCH_MAX_CANDIDATES", 200, 1, 2000),
  }
}

let engineOverride: SearchEngine | undefined
let defaultEngine: { key: string; engine: SearchEngine } | undefined

/** Test hook: force an engine (undefined restores env selection). */
export function setSearchEngineForTesting(engine: SearchEngine | undefined): void {
  engineOverride = engine
}

/** pg engine when MEETSUM_STORAGE=postgres, else the memory engine. */
export async function getSearchEngine(): Promise<SearchEngine> {
  if (engineOverride) return engineOverride

  const key = process.env.MEETSUM_STORAGE === "postgres" ? "pg" : "memory"

  if (defaultEngine?.key !== key) {
    const engine =
      key === "pg"
        ? (await import("@/lib/search/pg-engine")).createPgSearchEngine()
        : (await import("@/lib/search/memory-engine")).createMemorySearchEngine()

    defaultEngine = { key, engine }
  }

  return defaultEngine.engine
}

export type Degraded = NonNullable<SearchResponse["degraded"]>[number]

export type RankedCandidate = FusedCandidate & { chunk: HydratedChunk }

export type RankResult = {
  nq: NormalizedQuery
  mode: SearchMode
  degraded: Degraded[]
  candidates: RankedCandidate[]
}

/**
 * Normalize → embed (when capable) → legs → RRF → top `maxCandidates` →
 * hydrate (scope re-applied). Shared by `searchWorkspace` and
 * `retrievePassages`.
 */
export async function rankCandidates(
  ctx: SearchContext,
  input: { q: string; filters: SearchFilters; task: EmbeddingTask; engine?: SearchEngine; config?: SearchConfig }
): Promise<RankResult> {
  const engine = input.engine ?? (await getSearchEngine())
  const config = input.config ?? searchConfig()
  const nq = normalizeQuery(input.q)
  const tsquery = buildTsQuery(nq)
  const caps = await engine.capabilities(ctx)
  const degraded: Degraded[] = []
  const trgm = caps.trgm ? trgmQuery(nq) : null

  if (!caps.trgm) degraded.push("no_trgm")
  if (!tsquery && !trgm) return { nq, mode: "empty", degraded, candidates: [] }

  let vector: LegRequest["vector"] = null

  if (!caps.vector) degraded.push("no_vector")
  else if (!caps.embeddingKey) degraded.push("no_embedding_provider")
  else {
    const values = await (engine.queryVector
      ? engine.queryVector(ctx, input.q, input.task)
      : embedQuery(input.q, { task: input.task, workspaceId: ctx.workspaceId, principalKey: ctx.principalKey })
    ).catch(() => null)

    if (values && values.length === caps.embeddingKey.dimensions) vector = { key: caps.embeddingKey, values }
    else degraded.push("query_embedding_failed")
  }

  const { legs, failed } = await engine.runLegs(ctx, { nq, tsquery, trgm, filters: input.filters, vector, config })

  if (vector && failed?.includes("vector")) {
    vector = null
    degraded.push("query_embedding_failed")
  }

  const fused = fuse(legs, { k: config.rrfK, weights: config.weights }).slice(0, config.maxCandidates)
  const hydrated = new Map((await engine.hydrate(ctx, fused.map((candidate) => candidate.id))).map((chunk) => [chunk.id, chunk]))
  const candidates = fused.flatMap((candidate) => {
    const chunk = hydrated.get(candidate.id)

    return chunk ? [{ ...candidate, startedAt: chunk.meeting.startedAt, chunk }] : []
  })

  return { nq, mode: vector ? "hybrid" : "lexical", degraded, candidates }
}

/** Speaker of the turn containing `offset` ("<name>: …" lines), else the only speaker. */
function speakerAt(chunk: HydratedChunk, offset: number | undefined): string | undefined {
  if (chunk.kind !== "transcript") return undefined

  const lineStart = offset === undefined ? 0 : chunk.text.lastIndexOf("\n", offset) + 1
  const label = /^([^:\n]{1,60}):\s/.exec(chunk.text.slice(lineStart))

  if (label) return label[1].trim()

  const names = chunk.speakerIds.map((id) => chunk.speakerNames[id]).filter(Boolean)

  return names.length === 1 ? names[0] : undefined
}

export function toSearchHit(candidate: RankedCandidate, nq: NormalizedQuery): SearchHit {
  const { chunk } = candidate
  const snippet = buildSnippet(chunk.text, nq)
  const segment = pickCitationSegment(chunk, snippet.matchOffset)
  const speakerName = speakerAt(chunk, snippet.matchOffset)

  return {
    chunkId: chunk.id,
    meetingId: chunk.meetingId,
    kind: chunk.kind,
    ...(segment ? { segmentId: segment.segmentId } : {}),
    ...(segment?.startMs !== undefined ? { startMs: segment.startMs } : chunk.startMs !== undefined ? { startMs: chunk.startMs } : {}),
    ...(chunk.endMs !== undefined ? { endMs: chunk.endMs } : {}),
    ...(speakerName ? { speakerName } : {}),
    ...(chunk.language ? { language: chunk.language } : {}),
    snippet: snippet.snippet,
    highlights: snippet.highlights,
    score: candidate.score,
    legs: candidate.legs,
  }
}

/** Meeting score = best + 0.25·second + 0.1·third hit. */
export function groupScore(scores: number[]): number {
  const [first = 0, second = 0, third = 0] = [...scores].sort((a, b) => b - a)

  return first + 0.25 * second + 0.1 * third
}

function emptyResponse(params: SearchParams, nq: NormalizedQuery, started: number, mode: SearchMode = "empty"): SearchResponse {
  return {
    query: { q: params.q, folded: nq.folded, tokens: nq.tokens.map((token) => token.raw) },
    mode,
    ...(params.group === "meeting" ? { groups: [] } : { hits: [] }),
    nextCursor: null,
    tookMs: Date.now() - started,
  }
}

/** Principal key for a bare repository scope (repository delegation). */
export function scopePrincipalKey(scope: SearchContext["scope"]): string {
  if (scope.kind === "member") return scope.userId
  if (scope.kind === "api_key") return `key:${scope.ownerUserId ?? "anonymous"}`

  return "system"
}

/**
 * Ids of the best-matching visible meetings, best first (repository
 * `searchMeetings` delegation and compat routes).
 */
export async function searchMeetingIds(
  ctx: SearchContext,
  query: string,
  options: { limit?: number; filters?: SearchFilters } = {}
): Promise<string[]> {
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 20) || 20, 100))
  const ids: string[] = []
  let cursor: string | undefined

  do {
    const response = await searchWorkspace(ctx, {
      q: query,
      filters: options.filters ?? {},
      group: "meeting",
      limit: 25,
      hitsPerMeeting: 1,
      ...(cursor ? { cursor } : {}),
    })

    ids.push(...(response.groups ?? []).map((group) => group.meeting.id))
    cursor = response.nextCursor ?? undefined
  } while (cursor && ids.length < limit)

  return ids.slice(0, limit)
}

/**
 * Search the caller's visible meetings. Throws InvalidCursorError (→ 400)
 * for a cursor of another query, group or principal.
 */
export async function searchWorkspace(ctx: SearchContext, rawParams: SearchParams): Promise<SearchResponse> {
  const started = Date.now()
  const params = clampSearchParams(rawParams)
  const binding = cursorBinding({ principalKey: ctx.principalKey, q: params.q, filters: params.filters, group: params.group })
  const offset = params.cursor ? decodeCursor(params.cursor, binding) : 0
  const engine = await getSearchEngine()
  const nqEmpty = normalizeQuery(params.q)

  if (!params.q) {
    if (!hasFilters(params.filters)) return emptyResponse(params, nqEmpty, started)

    const { meetings, total } = await engine.listMeetings(ctx, params.filters, { limit: params.limit, offset })
    const pending = await engine.countPending(ctx, params.filters)

    return {
      query: { q: "", folded: "", tokens: [] },
      mode: "lexical",
      groups: params.group === "meeting" ? meetings.map((meeting) => ({ meeting, score: 0, hits: [] })) : undefined,
      hits: params.group === "chunk" ? [] : undefined,
      nextCursor: offset + meetings.length < total ? encodeCursor(offset + meetings.length, binding) : null,
      tookMs: Date.now() - started,
      ...(pending !== undefined ? { indexCoverage: { pending } } : {}),
    }
  }

  const ranked = await rankCandidates(ctx, { q: params.q, filters: params.filters, task: "RETRIEVAL_QUERY", engine })

  if (ranked.mode === "empty") return { ...emptyResponse(params, ranked.nq, started), degraded: ranked.degraded }

  const pending = await engine.countPending(ctx, params.filters)
  const base = {
    query: { q: params.q, folded: ranked.nq.folded, tokens: ranked.nq.tokens.map((token) => token.raw) },
    mode: ranked.mode,
    ...(pending !== undefined ? { indexCoverage: { pending } } : {}),
    ...(ranked.degraded.length ? { degraded: ranked.degraded } : {}),
  }

  if (params.group === "chunk") {
    const page = ranked.candidates.slice(offset, offset + params.limit)
    const next = offset + page.length

    return {
      ...base,
      hits: page.map((candidate) => toSearchHit(candidate, ranked.nq)),
      nextCursor: next < ranked.candidates.length ? encodeCursor(next, binding) : null,
      tookMs: Date.now() - started,
    }
  }

  const byMeeting = new Map<string, RankedCandidate[]>()

  for (const candidate of ranked.candidates) {
    const list = byMeeting.get(candidate.chunk.meetingId) ?? []

    list.push(candidate)
    byMeeting.set(candidate.chunk.meetingId, list)
  }

  const groups = [...byMeeting.values()]
    .map((list) => ({ list, score: groupScore(list.map((candidate) => candidate.score)) }))
    .sort((a, b) => b.score - a.score || b.list[0].chunk.meeting.startedAt.localeCompare(a.list[0].chunk.meeting.startedAt))
  const page = groups.slice(offset, offset + params.limit)
  const next = offset + page.length

  return {
    ...base,
    groups: page.map(({ list, score }) => ({
      meeting: list[0].chunk.meeting,
      score,
      hits: list.slice(0, params.hitsPerMeeting).map((candidate) => toSearchHit(candidate, ranked.nq)),
    })),
    nextCursor: next < groups.length ? encodeCursor(next, binding) : null,
    tookMs: Date.now() - started,
  }
}
