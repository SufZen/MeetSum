/**
 * In-memory search engine (docs/parity/m6.md, B5; owner: Package B): demo /
 * in-memory storage, route tests and the eval. Chunks the caller's visible
 * meetings with A's chunker and normalizer, scores an FTS-like leg (weight A
 * ×1, B ×0.6, `:*` prefixes) and a character-trigram leg, and fuses them with
 * the same RRF as Postgres. Mode is `lexical` unless a vector source is
 * injected (the eval's replay engine).
 *
 * Visibility: meetings are read through `ctx.meetings`, the caller's scoped
 * repository, so the index only ever contains visible meetings.
 */
import type { EmbeddingTask } from "@/lib/ai/embeddings/types"
import type { MeetingRecord } from "@/lib/meetings/repository"
import { buildChunkSources } from "@/lib/search/chunk-sources"
import { chunkTranscript } from "@/lib/search/chunker"
import { TEXT_LANGUAGES } from "@/lib/search/filters"
import { foldText, hebrewPrefixVariants, tokenize } from "@/lib/search/hebrew-normalize"
import { activeTokens } from "@/lib/search/query"
import type { LegRow, Legs } from "@/lib/search/rrf"
import type { HydratedChunk, LegRequest, SearchEngine, SearchMeetingMeta } from "@/lib/search/service"
import type {
  ChunkDraft,
  EmbeddingKey,
  MeetingChunk,
  NormalizedQuery,
  SearchContext,
  SearchFacets,
  SearchFilters,
  TextLanguage,
} from "@/lib/search/types"

/** Optional vector source (eval replay: recorded vectors keyed by text). */
export type MemoryVectorSource = {
  key: EmbeddingKey
  chunkVector(chunk: MeetingChunk): number[] | undefined
  queryVector(text: string, task: EmbeddingTask): number[] | undefined
}

export type MemoryEngineOptions = {
  /** Chunks for one meeting; defaults to A's chunker + chunk sources. */
  chunkMeeting?: (meeting: MeetingRecord) => ChunkDraft[]
  /** Visible meetings; defaults to paging `ctx.meetings.listMeetings`. */
  loadMeetings?: (ctx: SearchContext) => Promise<MeetingRecord[]>
  vectors?: MemoryVectorSource
  /** Upper bound on meetings indexed per request. */
  maxMeetings?: number
}

type IndexedChunk = HydratedChunk & { record: MeetingRecord; norm: string[]; stem: string[] }

type MemoryIndex = { chunks: IndexedChunk[]; byId: Map<string, IndexedChunk>; meetings: MeetingRecord[] }

const PAGE = 100

export function defaultChunkMeeting(meeting: MeetingRecord): ChunkDraft[] {
  return [
    ...chunkTranscript({
      segments: meeting.transcript ?? [],
      speakers: meeting.speakers ?? [],
      meetingLanguage: meeting.language,
    }),
    ...buildChunkSources(meeting),
  ]
}

async function loadVisibleMeetings(ctx: SearchContext, max: number): Promise<MeetingRecord[]> {
  const meetings: MeetingRecord[] = []

  for (let offset = 0; offset < max; offset += PAGE) {
    const page = await ctx.meetings.listMeetings({ limit: PAGE, offset, sort: "recent" })

    meetings.push(...page)
    if (page.length < PAGE) break
  }

  return meetings.slice(0, max)
}

export function meetingMeta(meeting: MeetingRecord): SearchMeetingMeta {
  const end = (meeting.transcript ?? []).reduce((max, segment) => Math.max(max, segment.endMs), 0)
  const durationMs = meeting.durationMs ?? (end > 0 ? end : undefined)

  return {
    id: meeting.id,
    title: meeting.title,
    startedAt: meeting.startedAt,
    source: meeting.source,
    ...(meeting.language ? { language: meeting.language } : {}),
    ...(meeting.intelligence?.meetingType ? { meetingType: meeting.intelligence.meetingType } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    tags: [...(meeting.tags ?? [])].map(String),
    rooms: (meeting.contexts ?? []).map((context) => ({ id: context.id, name: context.name })),
  }
}

function speakerNames(meeting: MeetingRecord): Record<string, string> {
  return Object.fromEntries((meeting.speakers ?? []).map((speaker) => [speaker.id, speaker.displayName ?? speaker.label]))
}

function participantKeys(meeting: MeetingRecord): Set<string> {
  const keys = new Set<string>()

  for (const name of meeting.participants) keys.add(foldText(name.trim()))
  for (const participant of meeting.participantDetails ?? []) {
    keys.add(foldText(participant.name.trim()))
    if (participant.email) keys.add(participant.email.trim().toLowerCase())
  }

  return keys
}

/** Meeting-level filters (dates, participants, rooms, tags, type, source, ids). */
export function meetingMatchesFilters(meeting: MeetingRecord, filters: SearchFilters): boolean {
  const day = meeting.startedAt.slice(0, 10)

  if (filters.from && day < filters.from) return false
  if (filters.to && day > filters.to) return false
  if (filters.meetingIds?.length && !filters.meetingIds.includes(meeting.id)) return false
  if (filters.sources?.length && !filters.sources.includes(meeting.source)) return false
  if (filters.meetingTypes?.length && !filters.meetingTypes.includes(meeting.intelligence?.meetingType ?? "")) {
    return false
  }
  if (filters.roomIds?.length && !(meeting.contexts ?? []).some((context) => filters.roomIds?.includes(context.id))) {
    return false
  }
  if (filters.tags?.length) {
    const wanted = new Set(filters.tags.map((tag) => tag.trim().toLowerCase()))

    if (!(meeting.tags ?? []).some((tag) => wanted.has(String(tag).toLowerCase()))) return false
  }
  if (filters.participants?.length) {
    const keys = participantKeys(meeting)

    if (!filters.participants.some((value) => keys.has(value.trim().toLowerCase()) || keys.has(foldText(value.trim())))) {
      return false
    }
  }

  return true
}

function chunkMatchesFilters(chunk: IndexedChunk, filters: SearchFilters): boolean {
  if (filters.kinds?.length && !filters.kinds.includes(chunk.kind)) return false
  if (filters.speakerIds?.length && !chunk.speakerIds.some((id) => filters.speakerIds?.includes(id))) return false
  if (filters.languages?.length) {
    const language = chunk.language ?? chunk.record.language

    if (!filters.languages.includes(language as TextLanguage)) return false
  }

  return meetingMatchesFilters(chunk.record, filters)
}

type Lexeme = { value: string; prefix: boolean }

function queryGroups(nq: NormalizedQuery): Lexeme[][] {
  return activeTokens(nq).map((token) =>
    [...new Set([token.raw, ...token.variants])]
      .filter(Boolean)
      .map((value) => ({ value, prefix: token.script !== "number" && [...value].length >= 3 }))
  )
}

function lexemeMatches(token: string, lexeme: Lexeme): boolean {
  return token === lexeme.value || (lexeme.prefix && token.startsWith(lexeme.value))
}

/**
 * FTS-like score: per query group, weight 1 when a raw (A) token matches,
 * 0.6 when only a stem (B) token does; tf dampened; normalized like
 * `ts_rank_cd(…, 32)` (rank / (rank + 1)). 0 when nothing matches.
 */
export function ftsScore(norm: string[], stem: string[], groups: Lexeme[][]): number {
  let rank = 0

  for (const group of groups) {
    let tf = 0

    for (const token of norm) if (group.some((lexeme) => lexemeMatches(token, lexeme))) tf += 1

    if (tf > 0) rank += 1 + Math.log(tf)
    else if (stem.some((token) => group.some((lexeme) => lexemeMatches(token, lexeme)))) rank += 0.6
  }

  return rank / (rank + 1)
}

function wordTrigrams(word: string): string[] {
  const padded = `  ${word} `
  const out: string[] = []

  for (let index = 0; index + 3 <= padded.length; index += 1) out.push(padded.slice(index, index + 3))

  return out
}

/**
 * pg_trgm-style `word_similarity(q, text)`: the best share of the query's
 * trigrams found in a contiguous run of words of the text.
 */
export function wordSimilarity(query: string, words: string[]): number {
  const queryWords = tokenize(query)
  const target = new Set(queryWords.flatMap(wordTrigrams))

  if (!target.size || !words.length) return 0

  const span = Math.max(1, queryWords.length)
  let best = 0

  for (let start = 0; start < words.length; start += 1) {
    const found = new Set<string>()

    for (let index = start; index < Math.min(words.length, start + span); index += 1) {
      for (const trigram of wordTrigrams(words[index])) if (target.has(trigram)) found.add(trigram)
    }
    best = Math.max(best, found.size / target.size)
    if (best === 1) break
  }

  return best
}

function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0

  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * (b[index] ?? 0)
    na += a[index] * a[index]
    nb += (b[index] ?? 0) * (b[index] ?? 0)
  }

  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

/** Synchronous text match (memory compat shim): any active token matches. */
export function textMatchesQuery(text: string | undefined, nq: NormalizedQuery): boolean {
  if (!text) return false

  const groups = queryGroups(nq)

  if (!groups.length) return false

  const words = tokenize(foldText(text))
  const forms = words.flatMap((word) => [word, ...hebrewPrefixVariants(word)])

  return groups.some((group) => forms.some((form) => group.some((lexeme) => lexemeMatches(form, lexeme))))
}

function rank(rows: LegRow[], limit: number): LegRow[] {
  return rows
    .sort((a, b) => b.score - a.score || (b.startedAt ?? "").localeCompare(a.startedAt ?? "") || a.id.localeCompare(b.id))
    .slice(0, limit)
}

export function createMemorySearchEngine(options: MemoryEngineOptions = {}): SearchEngine {
  const chunkMeeting = options.chunkMeeting ?? defaultChunkMeeting
  const maxMeetings = options.maxMeetings ?? 1000
  const perContext = new WeakMap<SearchContext, Promise<MemoryIndex>>()
  const perMeeting = new WeakMap<MeetingRecord, IndexedChunk[]>()

  function indexMeeting(ctx: SearchContext, meeting: MeetingRecord): IndexedChunk[] {
    const cached = perMeeting.get(meeting)

    if (cached) return cached

    const meta = meetingMeta(meeting)
    const names = speakerNames(meeting)
    const chunks = chunkMeeting(meeting).map((draft) => ({
      ...draft,
      id: `${meeting.id}:${draft.kind}:${draft.chunkIndex}`,
      workspaceId: meeting.workspaceId ?? ctx.workspaceId,
      meetingId: meeting.id,
      transcriptVersion: meeting.transcriptVersion ?? 0,
      meeting: meta,
      speakerNames: names,
      record: meeting,
      norm: draft.textNorm.split(/\s+/).filter(Boolean),
      stem: draft.textStem.split(/\s+/).filter(Boolean),
    }))

    perMeeting.set(meeting, chunks)

    return chunks
  }

  function index(ctx: SearchContext): Promise<MemoryIndex> {
    let pending = perContext.get(ctx)

    if (!pending) {
      pending = (options.loadMeetings ? options.loadMeetings(ctx) : loadVisibleMeetings(ctx, maxMeetings)).then(
        (meetings) => {
          const chunks = meetings.flatMap((meeting) => indexMeeting(ctx, meeting))

          return { chunks, byId: new Map(chunks.map((chunk) => [chunk.id, chunk])), meetings }
        }
      )
      perContext.set(ctx, pending)
    }

    return pending
  }

  const strip = (chunk: IndexedChunk): HydratedChunk => {
    const { record, norm, stem, ...hydrated } = chunk

    void record
    void norm
    void stem

    return hydrated
  }

  return {
    kind: "memory",

    async capabilities() {
      return { vector: Boolean(options.vectors), trgm: true, embeddingKey: options.vectors?.key ?? null }
    },

    async queryVector(_ctx, text, task) {
      return options.vectors?.queryVector(text, task) ?? null
    },

    async runLegs(ctx, request: LegRequest) {
      const { chunks } = await index(ctx)
      const groups = queryGroups(request.nq)
      const fts: LegRow[] = []
      const trgm: LegRow[] = []
      const vector: LegRow[] = []

      for (const chunk of chunks) {
        if (!chunkMatchesFilters(chunk, request.filters)) continue

        const startedAt = chunk.meeting.startedAt

        if (request.tsquery && groups.length) {
          const score = ftsScore(chunk.norm, chunk.stem, groups)

          if (score > 0) fts.push({ id: chunk.id, score, startedAt })
        }
        if (request.trgm) {
          const score = wordSimilarity(request.trgm, chunk.norm)

          if (score >= request.config.trgmThreshold) trgm.push({ id: chunk.id, score, startedAt })
        }
        if (request.vector && options.vectors) {
          const values = options.vectors.chunkVector(chunk)

          if (values) vector.push({ id: chunk.id, score: cosine(request.vector.values, values), startedAt })
        }
      }

      const legs: Legs = {
        fts: rank(fts, request.config.ftsK),
        ...(request.trgm ? { trgm: rank(trgm, request.config.trgmK) } : {}),
        ...(request.vector ? { vector: rank(vector, request.config.vectorK) } : {}),
      }

      return { legs }
    },

    async hydrate(ctx, ids) {
      const { byId } = await index(ctx)

      return ids.flatMap((id) => {
        const chunk = byId.get(id)

        return chunk ? [strip(chunk)] : []
      })
    },

    async listMeetings(ctx, filters, page) {
      const { meetings } = await index(ctx)
      const matching = meetings
        .filter((meeting) => meetingMatchesFilters(meeting, filters))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id))

      return { meetings: matching.slice(page.offset, page.offset + page.limit).map(meetingMeta), total: matching.length }
    },

    async countPending() {
      return undefined
    },

    async segmentTexts(ctx, segmentIds) {
      const { meetings } = await index(ctx)
      const wanted = new Set(segmentIds)
      const texts: Record<string, string> = {}

      for (const meeting of meetings) {
        for (const segment of meeting.transcript ?? []) if (wanted.has(segment.id)) texts[segment.id] = segment.text
      }

      return texts
    },

    async facets(ctx): Promise<SearchFacets> {
      const { meetings } = await index(ctx)
      const people = new Map<string, { name: string; email?: string; meetings: Set<string> }>()
      const speakers = new Map<string, string>()
      const rooms = new Map<string, string>()
      const tags = new Set<string>()
      const languages = new Set<TextLanguage>()
      const meetingTypes = new Set<string>()
      const sources = new Set<string>()

      for (const meeting of meetings) {
        const details = meeting.participantDetails?.length
          ? meeting.participantDetails.map((participant) => ({ name: participant.name, email: participant.email?.toLowerCase() }))
          : meeting.participants.map((name) => ({ name, email: undefined }))

        for (const person of details) {
          const key = `${person.name}\u0000${person.email ?? ""}`
          const entry = people.get(key) ?? { name: person.name, email: person.email, meetings: new Set<string>() }

          entry.meetings.add(meeting.id)
          people.set(key, entry)
        }
        for (const speaker of meeting.speakers ?? []) if (speaker.displayName) speakers.set(speaker.id, speaker.displayName)
        for (const context of meeting.contexts ?? []) rooms.set(context.id, context.name)
        for (const tag of meeting.tags ?? []) tags.add(String(tag))
        if (TEXT_LANGUAGES.includes(meeting.language as TextLanguage)) languages.add(meeting.language as TextLanguage)
        if (meeting.intelligence?.meetingType) meetingTypes.add(meeting.intelligence.meetingType)
        sources.add(meeting.source)
      }

      return {
        people: [...people.values()]
          .map((person) => ({ name: person.name, ...(person.email ? { email: person.email } : {}), count: person.meetings.size }))
          .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
          .slice(0, 200),
        speakers: [...speakers.entries()].slice(0, 200).map(([id, name]) => ({ id, name })),
        rooms: [...rooms.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
        tags: [...tags].sort(),
        languages: [...languages].sort(),
        meetingTypes: [...meetingTypes].sort(),
        sources: [...sources].sort(),
      }
    },
  }
}
