/**
 * Search page state <-> URL params (docs/parity/m6.md, D1; owner: Package D).
 * Pure and client-safe.
 *
 * The page URL uses the same parameter names as `GET /api/search` (B7), so a
 * shared link and the API request read the same:
 * `q, from, to, participant, room, tag, language, type, kind` (lists
 * repeatable), plus page-only `range` (date preset) and `tab`.
 */
import type { ChunkKind, TextLanguage } from "@/lib/search/types"

export const SEARCH_LANGUAGES: readonly TextLanguage[] = ["he", "en", "mixed"]
/** The kind chips shown in the filters bar (`meta` is never offered). */
export const SEARCH_KINDS: readonly ChunkKind[] = ["transcript", "summary", "item", "action_item", "chapter"]
export const DATE_PRESETS = ["7", "30", "90"] as const
export type DatePreset = (typeof DATE_PRESETS)[number]
export type SearchTab = "search" | "ask"

export const SEARCH_QUERY_MAX = 300

export type SearchUrlState = {
  q: string
  /** A preset wins over `from`/`to` (they are recomputed from today). */
  range?: DatePreset
  from?: string
  to?: string
  participants: string[]
  rooms: string[]
  tags: string[]
  languages: TextLanguage[]
  meetingTypes: string[]
  kinds: ChunkKind[]
  tab: SearchTab
}

export const EMPTY_SEARCH_STATE: SearchUrlState = {
  q: "",
  participants: [],
  rooms: [],
  tags: [],
  languages: [],
  meetingTypes: [],
  kinds: [],
  tab: "search",
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const MAX_LIST = 20

function isValidDate(value: string | null | undefined): value is string {
  if (!value || !ISO_DATE.test(value)) return false

  const date = new Date(`${value}T00:00:00Z`)

  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function uniqueList(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []

  for (const raw of values) {
    const value = raw.trim()

    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
    if (out.length >= MAX_LIST) break
  }

  return out
}

function toParams(input: URLSearchParams | string | Record<string, string | string[] | undefined>) {
  if (input instanceof URLSearchParams) return input
  if (typeof input === "string") return new URLSearchParams(input.startsWith("?") ? input.slice(1) : input)

  const params = new URLSearchParams()

  for (const [key, value] of Object.entries(input)) {
    if (Array.isArray(value)) value.forEach((item) => params.append(key, item))
    else if (typeof value === "string") params.append(key, value)
  }

  return params
}

/** Reads (and sanitizes) the state from a URL query string or params. */
export function parseSearchUrl(
  input: URLSearchParams | string | Record<string, string | string[] | undefined>
): SearchUrlState {
  const params = toParams(input)
  const range = params.get("range")
  const from = params.get("from")
  const to = params.get("to")
  const preset = (DATE_PRESETS as readonly string[]).includes(range ?? "") ? (range as DatePreset) : undefined

  return {
    q: (params.get("q") ?? "").slice(0, SEARCH_QUERY_MAX),
    ...(preset ? { range: preset } : {}),
    ...(!preset && isValidDate(from) ? { from } : {}),
    ...(!preset && isValidDate(to) ? { to } : {}),
    participants: uniqueList(params.getAll("participant")),
    rooms: uniqueList(params.getAll("room")),
    tags: uniqueList(params.getAll("tag")),
    languages: uniqueList(params.getAll("language")).filter((value): value is TextLanguage =>
      (SEARCH_LANGUAGES as readonly string[]).includes(value)
    ),
    meetingTypes: uniqueList(params.getAll("type")),
    kinds: uniqueList(params.getAll("kind")).filter((value): value is ChunkKind =>
      (SEARCH_KINDS as readonly string[]).includes(value)
    ),
    tab: params.get("tab") === "ask" ? "ask" : "search",
  }
}

function appendFilters(params: URLSearchParams, state: SearchUrlState) {
  state.participants.forEach((value) => params.append("participant", value))
  state.rooms.forEach((value) => params.append("room", value))
  state.tags.forEach((value) => params.append("tag", value))
  state.languages.forEach((value) => params.append("language", value))
  state.meetingTypes.forEach((value) => params.append("type", value))
  state.kinds.forEach((value) => params.append("kind", value))
}

/** The page query string (no leading "?"; empty when nothing is set). */
export function serializeSearchUrl(state: SearchUrlState): string {
  const params = new URLSearchParams()
  const q = state.q.trim()

  if (q) params.set("q", q)
  if (state.range) params.set("range", state.range)
  else {
    if (state.from) params.set("from", state.from)
    if (state.to) params.set("to", state.to)
  }
  appendFilters(params, state)
  if (state.tab === "ask") params.set("tab", "ask")

  return params.toString()
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** `{from, to}` (inclusive ISO days) for a preset, relative to `now`. */
export function datePresetRange(preset: DatePreset, now: Date = new Date()): { from: string; to: string } {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const from = new Date(to.getTime() - (Number(preset) - 1) * 86_400_000)

  return { from: isoDay(from), to: isoDay(to) }
}

export function hasActiveFilters(state: SearchUrlState): boolean {
  return Boolean(
    state.range ||
      state.from ||
      state.to ||
      state.participants.length ||
      state.rooms.length ||
      state.tags.length ||
      state.languages.length ||
      state.meetingTypes.length ||
      state.kinds.length
  )
}

export function clearFilters(state: SearchUrlState): SearchUrlState {
  return { ...EMPTY_SEARCH_STATE, q: state.q, tab: state.tab }
}

/** Something to search for: a query, or filters alone (B5: empty q + filters). */
export function isSearchable(state: SearchUrlState): boolean {
  return Boolean(state.q.trim()) || hasActiveFilters(state)
}

/** `GET /api/search` params for this state (B7). */
export function buildSearchApiParams(
  state: SearchUrlState,
  options: { group?: "meeting" | "chunk"; limit?: number; hits?: number; cursor?: string | null; now?: Date } = {}
): URLSearchParams {
  const params = new URLSearchParams()
  const q = state.q.trim()

  if (q) params.set("q", q)

  if (state.range) {
    const { from, to } = datePresetRange(state.range, options.now)

    params.set("from", from)
    params.set("to", to)
  } else {
    if (state.from) params.set("from", state.from)
    if (state.to) params.set("to", state.to)
  }
  appendFilters(params, state)
  params.set("group", options.group ?? "meeting")
  if (options.limit) params.set("limit", String(options.limit))
  if (options.hits) params.set("hits", String(options.hits))
  if (options.cursor) params.set("cursor", options.cursor)

  return params
}

/** Stable identity of a search request (ignores the tab and the cursor). */
export function searchKey(state: SearchUrlState): string {
  return serializeSearchUrl({ ...state, tab: "search" })
}

/** Toggles a value in one of the list filters. */
export function toggleListValue<T extends string>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value]
}
