/**
 * The eval harness with B's spec-shaped doubles for A's normalizer and
 * chunkers: metric math, corpus integrity, and that the lexical/pglite
 * engines beat the legacy baseline. The real thresholds against A's modules
 * live in search-eval.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/search/hebrew-normalize", async () => (await import("./helpers/search-doubles")).normalizerDouble)
vi.mock("@/lib/search/chunker", async () => (await import("./helpers/search-doubles")).chunkerDouble)
vi.mock("@/lib/search/chunk-sources", async () => (await import("./helpers/search-doubles")).chunkSourcesDouble)

import { EVAL_CATEGORIES, ORTHOGRAPHIC_CATEGORIES, loadCorpus } from "@/lib/search/eval/corpus"
import {
  createLegacyEngine,
  createLexicalEngine,
  createPgliteEngine,
  createReplayEngine,
  queryFixtureKey,
  type EmbeddingFixture,
  type EvalEngine,
} from "@/lib/search/eval/engines"
import { firstRelevantRank, metricsOf } from "@/lib/search/eval/metrics"
import { renderReport, runEngine, type EngineReport } from "@/lib/search/eval/run"
import { defaultChunkMeeting } from "@/lib/search/memory-engine"

const corpus = loadCorpus()

describe("eval metrics", () => {
  it("ranks the first relevant hit, segment-aware", () => {
    const gold = { meetingId: "m1", segmentIds: ["m1_s02"] }

    expect(firstRelevantRank([{ meetingId: "m2", segmentIds: ["m1_s02"] }, { meetingId: "m1", segmentIds: ["m1_s01", "m1_s02"] }], gold)).toBe(2)
    expect(firstRelevantRank([{ meetingId: "m1", segmentIds: ["m1_s01"] }], gold)).toBeNull()
    expect(firstRelevantRank([{ meetingId: "m1", segmentIds: [] }], { meetingId: "m1", segmentIds: [] })).toBe(1)
  })

  it("computes recall@k and MRR@10", () => {
    const metrics = metricsOf([
      { id: "a", category: "prefix", rank: 1 },
      { id: "b", category: "prefix", rank: 4 },
      { id: "c", category: "prefix", rank: 12 },
      { id: "d", category: "prefix", rank: null },
    ])

    expect(metrics).toEqual({ n: 4, recall1: 0.25, recall5: 0.5, recall10: 0.5, mrr10: (1 + 0.25) / 4 })
  })
})

describe("eval corpus", () => {
  it("has 12 meetings and 50 queries in the documented category mix", () => {
    const count = (category: string) => corpus.queries.filter((query) => query.category === category).length

    expect(corpus.meetings).toHaveLength(12)
    expect(corpus.queries).toHaveLength(50)
    expect(Object.fromEntries(EVAL_CATEGORIES.map((category) => [category, count(category)]))).toEqual({
      prefix: 15,
      plural_finals: 5,
      gershayim: 4,
      niqqud: 3,
      latin: 5,
      names: 4,
      numbers: 3,
      short_tokens: 3,
      filters: 3,
      paraphrase: 5,
    })
  })

  it("every gold meeting and segment exists", () => {
    for (const query of corpus.queries) {
      const meeting = corpus.meetings.find((item) => item.id === query.gold.meetingId)

      expect(meeting, query.id).toBeDefined()
      for (const id of query.gold.segmentIds) expect(meeting?.transcript?.some((segment) => segment.id === id), `${query.id} ${id}`).toBe(true)
    }
  })
})

describe("eval engines (doubles)", () => {
  const reports: Record<string, EngineReport> = {}
  let pglite: EvalEngine | null = null

  beforeAll(async () => {
    reports.legacy = await runEngine(corpus, createLegacyEngine(corpus))
    reports.lexical = await runEngine(corpus, createLexicalEngine(corpus))
    pglite = await createPgliteEngine(corpus)
    if (pglite) reports.pglite = await runEngine(corpus, pglite)
  }, 120_000)

  afterAll(async () => {
    await pglite?.close?.()
  })

  it("lexical meets the orthographic thresholds and beats legacy", () => {
    for (const category of ORTHOGRAPHIC_CATEGORIES) {
      expect(reports.lexical.metrics[category].recall5, category).toBeGreaterThanOrEqual(0.95)
      expect(reports.lexical.metrics[category].mrr10, category).toBeGreaterThanOrEqual(0.8)
    }
    expect(reports.lexical.metrics.overall.recall5).toBeGreaterThan(reports.legacy.metrics.overall.recall5)
    expect(reports.lexical.metrics.prefix.recall5).toBeGreaterThan(reports.legacy.metrics.prefix.recall5)
  })

  it("pglite (real SQL legs) stays within 0.05 of lexical", () => {
    if (!reports.pglite) return

    for (const category of ORTHOGRAPHIC_CATEGORIES) {
      expect(reports.pglite.metrics[category].recall5, category).toBeGreaterThanOrEqual(reports.lexical.metrics[category].recall5 - 0.05)
    }
  })

  it("replay uses recorded vectors (synthetic fixture) and helps paraphrases", async () => {
    // Synthetic oracle vectors: each meeting is one axis; queries point at their gold meeting.
    const axis = (index: number) => Array.from({ length: corpus.meetings.length }, (_, i) => (i === index ? 1 : 0))
    const fixture: EmbeddingFixture = { model: "oracle", dimensions: corpus.meetings.length, chunks: {}, queries: {} }

    corpus.meetings.forEach((meeting, index) => {
      for (const draft of defaultChunkMeeting(meeting)) fixture.chunks[draft.contentHash] = axis(index)
    })
    for (const query of corpus.queries) {
      fixture.queries[queryFixtureKey("RETRIEVAL_QUERY", query.q)] = axis(corpus.meetings.findIndex((meeting) => meeting.id === query.gold.meetingId))
    }

    const replay = await runEngine(corpus, createReplayEngine(corpus, fixture))

    expect(replay.metrics.paraphrase.recall5).toBeGreaterThan(reports.lexical.metrics.paraphrase.recall5)
  })

  it("renders a report without query or transcript text", () => {
    const markdown = renderReport(Object.values(reports), {
      date: "2026-10-13",
      sha: "abc",
      corpusSha256: corpus.sha256,
      queryCount: corpus.queries.length,
      meetingCount: corpus.meetings.length,
      replayAvailable: false,
      notes: [],
    })

    expect(markdown).toContain("SYNTHETIC — replay pending")
    expect(markdown).toContain("| prefix | 15 |")
    for (const query of corpus.queries) if (/[א-ת]/.test(query.q)) expect(markdown).not.toContain(query.q)
    for (const meeting of corpus.meetings) expect(markdown).not.toContain(meeting.transcript![0].text)
  })
})
