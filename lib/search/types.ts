/**
 * M6 search contracts (docs/parity/m6.md, "Shared contracts"; Step 0).
 * Frozen after Step 0: changes go through the orchestrator.
 */
import type { MeetingRepository, RepoScope } from "@/lib/meetings/repository"

export type ChunkKind = "transcript" | "summary" | "item" | "action_item" | "chapter" | "meta"

export type TextLanguage = "he" | "en" | "mixed"

export type ChunkDraft = {
  kind: ChunkKind
  chunkIndex: number
  sourceId?: string
  segmentIds: string[]
  segmentStartMs: number[]
  segmentOffsets: number[]
  overlapCount: number
  speakerIds: string[]
  startMs?: number
  endMs?: number
  language?: TextLanguage
  text: string
  textNorm: string
  textStem: string
  tokenEstimate: number
  contentHash: string
}

export type MeetingChunk = ChunkDraft & {
  id: string
  workspaceId: string
  meetingId: string
  transcriptVersion: number
}

/** Stored on every vector row. */
export type EmbeddingKey = { model: string; dimensions: number }

export const formatEmbeddingKey = (k: EmbeddingKey) => `${k.model}:${k.dimensions}`

export type SearchCapabilities = {
  vector: {
    available: boolean
    installedVersion?: string
    tableReady: boolean
    indexReady: boolean
    reason?: string
  }
  trgm: { installed: boolean; hebrew: boolean }
  /** Active key when a provider is configured. */
  embeddingKey: EmbeddingKey | null
  checkedAt: string
}

export type SearchMode = "hybrid" | "lexical" | "empty"

export type QueryToken = {
  raw: string
  variants: string[]
  script: "he" | "latin" | "number" | "mixed"
  stop: boolean
}

export type NormalizedQuery = { input: string; folded: string; tokens: QueryToken[] }

export type SearchScope =
  | { kind: "meeting"; meetingId: string }
  | { kind: "room"; roomId: string }
  | { kind: "workspace" }

export type SearchFilters = {
  /** ISO date, inclusive. */
  from?: string
  /** ISO date, inclusive. */
  to?: string
  participants?: string[]
  speakerIds?: string[]
  roomIds?: string[]
  tags?: string[]
  languages?: TextLanguage[]
  meetingTypes?: string[]
  sources?: string[]
  kinds?: ChunkKind[]
  meetingIds?: string[]
}

export type SearchParams = {
  q: string
  filters: SearchFilters
  group: "meeting" | "chunk"
  limit: number
  hitsPerMeeting: number
  cursor?: string
}

export type LegScores = {
  vector?: { rank: number; similarity: number }
  fts?: { rank: number; score: number }
  trgm?: { rank: number; score: number }
}

export type SearchHit = {
  chunkId: string
  meetingId: string
  kind: ChunkKind
  segmentId?: string
  startMs?: number
  endMs?: number
  speakerName?: string
  language?: TextLanguage
  snippet: string
  highlights: [number, number][]
  score: number
  legs: LegScores
}

export type SearchMeetingGroup = {
  meeting: {
    id: string
    title: string
    startedAt: string
    source: string
    language?: string
    meetingType?: string
    durationMs?: number
    tags: string[]
    rooms: { id: string; name: string }[]
  }
  score: number
  hits: SearchHit[]
}

export type SearchResponse = {
  query: { q: string; folded: string; tokens: string[] }
  mode: SearchMode
  groups?: SearchMeetingGroup[]
  hits?: SearchHit[]
  nextCursor: string | null
  tookMs: number
  indexCoverage?: { pending: number }
  degraded?: ("no_vector" | "no_embedding_provider" | "query_embedding_failed" | "no_trgm")[]
}

export type RetrievedPassage = {
  chunk: MeetingChunk
  meetingTitle: string
  meetingStartedAt: string
  speakerNames: Record<string, string>
  segmentTexts: Record<string, string>
  score: number
}

export type RetrieveRequest = {
  question: string
  previousQuestion?: string
  scope: SearchScope
  limit?: number
  budgetTokens?: number
}

export type RetrieveResult = {
  passages: RetrievedPassage[]
  mode: SearchMode
  topSimilarity: number | null
  lexicalHits: number
}

export type SearchContext = {
  scope: RepoScope
  workspaceId: string
  principalKey: string
  meetings: MeetingRepository
  locale?: "he" | "en"
}

export type SearchFacets = {
  people: { name: string; email?: string; count: number }[]
  speakers: { id: string; name: string }[]
  rooms: { id: string; name: string }[]
  tags: string[]
  languages: TextLanguage[]
  meetingTypes: string[]
  sources: string[]
}
