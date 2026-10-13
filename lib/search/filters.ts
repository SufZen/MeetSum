/**
 * Search filters: request parsing/validation and parameterised SQL clauses
 * (docs/parity/m6.md, B2/B7; owner: Package B). Every filter value is a
 * bound parameter; nothing user-supplied is interpolated into SQL.
 */
import type { ChunkKind, SearchFilters, SearchParams, SearchScope, TextLanguage } from "@/lib/search/types"

export const CHUNK_KINDS: readonly ChunkKind[] = ["transcript", "summary", "item", "action_item", "chapter", "meta"]
export const TEXT_LANGUAGES: readonly TextLanguage[] = ["he", "en", "mixed"]

export const MAX_QUERY_CHARS = 300
export const MAX_GROUP_LIMIT = 25
export const MAX_CHUNK_LIMIT = 50
export const DEFAULT_GROUP_LIMIT = 10
export const DEFAULT_CHUNK_LIMIT = 20
export const DEFAULT_HITS_PER_MEETING = 3
export const MAX_HITS_PER_MEETING = 10
const MAX_LIST_VALUES = 50
const MAX_VALUE_CHARS = 200

const ARRAY_KEYS = [
  "participants",
  "speakerIds",
  "roomIds",
  "tags",
  "languages",
  "meetingTypes",
  "sources",
  "kinds",
  "meetingIds",
] as const satisfies readonly (keyof SearchFilters)[]

export function hasFilters(filters: SearchFilters): boolean {
  return Boolean(filters.from || filters.to || ARRAY_KEYS.some((key) => (filters[key]?.length ?? 0) > 0))
}

/** A search scope expressed as filters (meeting → meetingIds, room → roomIds). */
export function scopeFilters(scope: SearchScope, base: SearchFilters = {}): SearchFilters {
  if (scope.kind === "meeting") return { ...base, meetingIds: [scope.meetingId] }
  if (scope.kind === "room") return { ...base, roomIds: [scope.roomId] }

  return { ...base }
}

/** `YYYY-MM-DD` from an ISO date or timestamp; null when invalid. */
export function isoDay(value: string): string | null {
  const day = value.trim().slice(0, 10)

  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null

  const parsed = new Date(`${day}T00:00:00.000Z`)

  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day ? null : day
}

export class SearchRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SearchRequestError"
  }
}

function list(params: URLSearchParams, name: string): string[] {
  const values = params
    .getAll(name)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean)

  if (values.length > MAX_LIST_VALUES) throw new SearchRequestError(`Too many ${name} values`)
  if (values.some((value) => value.length > MAX_VALUE_CHARS)) throw new SearchRequestError(`${name} value too long`)

  return [...new Set(values)]
}

function intParam(params: URLSearchParams, name: string, fallback: number, max: number): number {
  const raw = params.get(name)

  if (raw === null || raw.trim() === "") return fallback

  const value = Number(raw)

  if (!Number.isInteger(value) || value < 1) throw new SearchRequestError(`Invalid ${name}`)

  return Math.min(value, max)
}

/**
 * `GET /api/search` parameters. Throws SearchRequestError (→ 400) for an
 * over-long `q`, an unknown `kind`/`language`/`group`, or an invalid date.
 */
export function parseSearchParams(params: URLSearchParams): SearchParams {
  const q = (params.get("q") ?? "").trim()

  if (q.length > MAX_QUERY_CHARS) throw new SearchRequestError(`q must be at most ${MAX_QUERY_CHARS} characters`)

  const group = params.get("group") ?? "meeting"

  if (group !== "meeting" && group !== "chunk") throw new SearchRequestError("Invalid group")

  const kinds = list(params, "kind")
  const languages = list(params, "language")

  if (kinds.some((kind) => !CHUNK_KINDS.includes(kind as ChunkKind))) throw new SearchRequestError("Invalid kind")
  if (languages.some((language) => !TEXT_LANGUAGES.includes(language as TextLanguage))) {
    throw new SearchRequestError("Invalid language")
  }

  const filters: SearchFilters = {}

  for (const name of ["from", "to"] as const) {
    const raw = params.get(name)

    if (raw && raw.trim()) {
      const day = isoDay(raw)

      if (!day) throw new SearchRequestError(`Invalid ${name} date`)
      filters[name] = day
    }
  }

  const assign = <K extends (typeof ARRAY_KEYS)[number]>(key: K, values: string[]) => {
    if (values.length) (filters as Record<string, unknown>)[key] = values
  }

  assign("participants", list(params, "participant"))
  assign("speakerIds", list(params, "speaker"))
  assign("roomIds", list(params, "room"))
  assign("tags", list(params, "tag"))
  assign("languages", languages)
  assign("meetingTypes", list(params, "type"))
  assign("sources", list(params, "source"))
  assign("kinds", kinds)
  assign("meetingIds", list(params, "meetingId"))

  const cursor = params.get("cursor")?.trim()

  return {
    q,
    filters,
    group,
    limit: intParam(
      params,
      "limit",
      group === "meeting" ? DEFAULT_GROUP_LIMIT : DEFAULT_CHUNK_LIMIT,
      group === "meeting" ? MAX_GROUP_LIMIT : MAX_CHUNK_LIMIT
    ),
    hitsPerMeeting: intParam(params, "hits", DEFAULT_HITS_PER_MEETING, MAX_HITS_PER_MEETING),
    ...(cursor ? { cursor } : {}),
  }
}

/** Clamps programmatic params (service entry) to the documented limits. */
export function clampSearchParams(params: SearchParams): SearchParams {
  const max = params.group === "meeting" ? MAX_GROUP_LIMIT : MAX_CHUNK_LIMIT
  const fallback = params.group === "meeting" ? DEFAULT_GROUP_LIMIT : DEFAULT_CHUNK_LIMIT
  const limit = Number.isInteger(params.limit) && params.limit > 0 ? Math.min(params.limit, max) : fallback
  const hits =
    Number.isInteger(params.hitsPerMeeting) && params.hitsPerMeeting > 0
      ? Math.min(params.hitsPerMeeting, MAX_HITS_PER_MEETING)
      : DEFAULT_HITS_PER_MEETING

  return { ...params, q: params.q.trim().slice(0, MAX_QUERY_CHARS * 8), limit, hitsPerMeeting: hits }
}

/**
 * Filter clauses for a query over `meetings m` (and `meeting_chunks c` when
 * `chunk` is true). Placeholders are numbered from `values.length`.
 */
export function filterClauses(filters: SearchFilters, values: unknown[], options: { chunk: boolean }): string[] {
  const param = (value: unknown) => {
    values.push(value)
    return `$${values.length}`
  }
  const clauses: string[] = []
  const nonEmpty = (items: string[] | undefined) => (items ?? []).filter(Boolean)

  if (filters.from) clauses.push(`m.started_at >= ${param(filters.from)}::date`)
  if (filters.to) clauses.push(`m.started_at < (${param(filters.to)}::date + interval '1 day')`)

  const participants = nonEmpty(filters.participants).map((value) => value.trim().toLowerCase())

  if (participants.length) {
    const list = param(participants)

    clauses.push(
      `exists (select 1 from meeting_participants p where p.meeting_id = m.id ` +
        `and (lower(p.email) = any(${list}::text[]) or lower(p.name) = any(${list}::text[])))`
    )
  }

  const speakers = nonEmpty(filters.speakerIds)

  if (speakers.length) {
    clauses.push(
      options.chunk
        ? `c.speaker_ids && ${param(speakers)}::text[]`
        : `exists (select 1 from speakers s where s.meeting_id = m.id and s.id = any(${param(speakers)}::text[]))`
    )
  }

  const rooms = nonEmpty(filters.roomIds)

  if (rooms.length) {
    clauses.push(
      `exists (select 1 from meeting_contexts mc join contexts x on x.id = mc.context_id ` +
        `and x.workspace_id = m.workspace_id where mc.meeting_id = m.id and mc.context_id = any(${param(rooms)}::text[]))`
    )
  }

  const tags = nonEmpty(filters.tags).map((value) => value.trim().toLowerCase())

  if (tags.length) {
    clauses.push(
      `exists (select 1 from meeting_tags mt join tags t on t.id = mt.tag_id ` +
        `and t.workspace_id = m.workspace_id where mt.meeting_id = m.id and lower(t.name) = any(${param(tags)}::text[]))`
    )
  }

  const languages = nonEmpty(filters.languages)

  if (languages.length) {
    clauses.push(
      options.chunk
        ? `coalesce(c.language, m.language) = any(${param(languages)}::text[])`
        : `m.language = any(${param(languages)}::text[])`
    )
  }

  const types = nonEmpty(filters.meetingTypes)

  if (types.length) clauses.push(`m.meeting_type = any(${param(types)}::text[])`)

  const sources = nonEmpty(filters.sources)

  if (sources.length) clauses.push(`m.source = any(${param(sources)}::text[])`)

  const kinds = nonEmpty(filters.kinds)

  if (kinds.length && options.chunk) clauses.push(`c.kind = any(${param(kinds)}::text[])`)

  const meetingIds = nonEmpty(filters.meetingIds)

  if (meetingIds.length) clauses.push(`m.id = any(${param(meetingIds)}::text[])`)

  return clauses
}
