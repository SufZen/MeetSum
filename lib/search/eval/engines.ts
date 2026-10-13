/**
 * Eval engines (docs/parity/m6.md, B8):
 * - `legacy`: frozen copy of the pre-M6 `lib/memory.ts` tokenizer (baseline).
 * - `lexical`: the memory engine (A's chunker + normalizer, FTS-like + trigram, RRF).
 * - `pglite`: migration 025 on PGlite with pg_trgm and the real pg engine SQL.
 * - `replay`: the memory engine plus recorded embedding vectors
 *   (`tests/fixtures/search/embeddings.<model>-<dims>.json`); runs with no keys.
 */
import { existsSync, readFileSync } from "node:fs"

import type { EmbeddingTask } from "@/lib/ai/embeddings/types"
import type { MeetingRecord, MeetingRepository } from "@/lib/meetings/repository"
import type { EvalCorpus, EvalQuery } from "@/lib/search/eval/corpus"
import type { EvalHit } from "@/lib/search/eval/metrics"
import { createPgliteSearchDb, seedPgliteMeetings } from "@/lib/search/eval/pglite"
import {
  createMemorySearchEngine,
  defaultChunkMeeting,
  meetingMatchesFilters,
  type MemoryVectorSource,
} from "@/lib/search/memory-engine"
import { createPgSearchEngine } from "@/lib/search/pg-engine"
import { rankCandidates, type SearchEngine } from "@/lib/search/service"
import type { ChunkDraft, EmbeddingKey, SearchContext } from "@/lib/search/types"

export const TOP_K = 10

export type EvalEngine = {
  name: "legacy" | "lexical" | "pglite" | "replay" | "live"
  search(query: EvalQuery): Promise<EvalHit[]>
  close?(): Promise<void>
}

export type ChunkMeeting = (meeting: MeetingRecord) => ChunkDraft[]

function evalContext(corpus: EvalCorpus): SearchContext {
  return {
    scope: { kind: "system", workspaceId: corpus.workspaceId },
    workspaceId: corpus.workspaceId,
    principalKey: "eval",
    meetings: {} as MeetingRepository,
  }
}

// ---- legacy (frozen pre-M6 lib/memory.ts matching; do not "fix") ----------

function legacyTokenize(value: string) {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 2)
}

function legacyMatches(text: string | undefined, tokens: string[]) {
  if (!text || !tokens.length) return 0
  const normalized = text.toLowerCase()

  return tokens.filter((token) => normalized.includes(token)).length
}

export function createLegacyEngine(corpus: EvalCorpus): EvalEngine {
  return {
    name: "legacy",
    async search(query) {
      const tokens = legacyTokenize(query.q)
      const scored: { hit: EvalHit; score: number; startedAt: string }[] = []

      for (const meeting of corpus.meetings) {
        if (query.filters && !meetingMatchesFilters(meeting, query.filters)) continue

        for (const segment of meeting.transcript ?? []) {
          const score = legacyMatches(segment.text, tokens)

          if (score) scored.push({ hit: { meetingId: meeting.id, segmentIds: [segment.id] }, score, startedAt: meeting.startedAt })
        }
        for (const text of [meeting.summary?.overview, ...(meeting.summary?.decisions ?? []), ...(meeting.tags ?? [])]) {
          const score = legacyMatches(text, tokens)

          if (score) scored.push({ hit: { meetingId: meeting.id, segmentIds: [] }, score, startedAt: meeting.startedAt })
        }
        for (const item of meeting.summary?.actionItems ?? []) {
          const score = legacyMatches(item.title, tokens)

          if (score) {
            scored.push({
              hit: { meetingId: meeting.id, segmentIds: item.sourceSegmentId ? [item.sourceSegmentId] : [] },
              score,
              startedAt: meeting.startedAt,
            })
          }
        }
      }

      return scored
        .sort((a, b) => b.score - a.score || b.startedAt.localeCompare(a.startedAt))
        .slice(0, TOP_K)
        .map((entry) => entry.hit)
    },
  }
}

// ---- engines over the search service --------------------------------------

function serviceEngine(name: EvalEngine["name"], corpus: EvalCorpus, engine: SearchEngine, close?: () => Promise<void>): EvalEngine {
  const ctx = evalContext(corpus)

  return {
    name,
    async search(query) {
      const ranked = await rankCandidates(ctx, { q: query.q, filters: query.filters ?? {}, task: "RETRIEVAL_QUERY", engine })

      return ranked.candidates.slice(0, TOP_K).map((candidate) => ({
        meetingId: candidate.chunk.meetingId,
        segmentIds: candidate.chunk.segmentIds.slice(Math.max(0, candidate.chunk.overlapCount)),
      }))
    },
    ...(close ? { close } : {}),
  }
}

export function createLexicalEngine(corpus: EvalCorpus, chunkMeeting: ChunkMeeting = defaultChunkMeeting): EvalEngine {
  return serviceEngine(
    "lexical",
    corpus,
    createMemorySearchEngine({ chunkMeeting, loadMeetings: async () => corpus.meetings })
  )
}

/** Null when PGlite cannot load. */
export async function createPgliteEngine(
  corpus: EvalCorpus,
  chunkMeeting: ChunkMeeting = defaultChunkMeeting
): Promise<EvalEngine | null> {
  const db = await createPgliteSearchDb()

  if (!db) return null

  await seedPgliteMeetings(db, corpus.meetings, chunkMeeting)

  const engine = createPgSearchEngine({
    client: db.client,
    capabilities: async () => ({
      vector: { available: false, tableReady: false, indexReady: false, reason: "pglite_without_vector" },
      trgm: { installed: true, hebrew: db.hebrewTrigrams },
      embeddingKey: null,
      checkedAt: new Date().toISOString(),
    }),
  })

  return serviceEngine("pglite", corpus, engine, db.close)
}

// ---- replay ----------------------------------------------------------------

/** Recorded vectors: chunks by content hash, queries by `task|text`. */
export type EmbeddingFixture = {
  model: string
  dimensions: number
  recordedAt?: string
  chunks: Record<string, number[]>
  queries: Record<string, number[]>
}

export function replayFixturePath(key: EmbeddingKey = { model: "gemini-embedding-001", dimensions: 1536 }) {
  return `tests/fixtures/search/embeddings.${key.model}-${key.dimensions}.json`
}

export function queryFixtureKey(task: EmbeddingTask, text: string) {
  return `${task}|${text}`
}

export function vectorSourceFromFixture(fixture: EmbeddingFixture): MemoryVectorSource {
  return {
    key: { model: fixture.model, dimensions: fixture.dimensions },
    chunkVector: (chunk) => fixture.chunks[chunk.contentHash],
    queryVector: (text, task) => fixture.queries[queryFixtureKey(task, text)],
  }
}

export function loadReplayFixture(file = replayFixturePath()): EmbeddingFixture | null {
  if (!existsSync(file)) return null

  return JSON.parse(readFileSync(file, "utf8")) as EmbeddingFixture
}

export function createReplayEngine(
  corpus: EvalCorpus,
  fixture: EmbeddingFixture,
  chunkMeeting: ChunkMeeting = defaultChunkMeeting,
  name: EvalEngine["name"] = "replay"
): EvalEngine {
  return serviceEngine(
    name,
    corpus,
    createMemorySearchEngine({ chunkMeeting, loadMeetings: async () => corpus.meetings, vectors: vectorSourceFromFixture(fixture) })
  )
}

/**
 * Records a replay fixture with an embedding provider (live mode): every
 * corpus chunk (RETRIEVAL_DOCUMENT, title = meeting title) and every query
 * (RETRIEVAL_QUERY). Holds vectors only, never text.
 */
export async function recordReplayFixture(
  corpus: EvalCorpus,
  provider: {
    key: EmbeddingKey
    embed(
      inputs: { text: string; title?: string }[],
      opts: { task: EmbeddingTask }
    ): Promise<{ vectors: number[][] }>
  },
  chunkMeeting: ChunkMeeting = defaultChunkMeeting
): Promise<EmbeddingFixture> {
  const chunks: Record<string, number[]> = {}

  for (const meeting of corpus.meetings) {
    const drafts = chunkMeeting(meeting).filter((draft) => !chunks[draft.contentHash])

    for (let index = 0; index < drafts.length; index += 50) {
      const batch = drafts.slice(index, index + 50)
      const { vectors } = await provider.embed(
        batch.map((draft) => ({ text: draft.text, title: meeting.title })),
        { task: "RETRIEVAL_DOCUMENT" }
      )

      batch.forEach((draft, offset) => (chunks[draft.contentHash] = vectors[offset]))
    }
  }

  const queries: Record<string, number[]> = {}
  const texts = [...new Set(corpus.queries.map((query) => query.q))]
  const { vectors } = await provider.embed(texts.map((text) => ({ text })), { task: "RETRIEVAL_QUERY" })

  texts.forEach((text, index) => (queries[queryFixtureKey("RETRIEVAL_QUERY", text)] = vectors[index]))

  return { model: provider.key.model, dimensions: provider.key.dimensions, recordedAt: new Date().toISOString(), chunks, queries }
}
