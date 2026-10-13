/**
 * CI thresholds for the M6 retrieval eval (docs/parity/m6.md, B8) against
 * Package A's REAL normalizer and chunkers. Skipped while A's modules are
 * still the Step 0 stubs (no prefix variants / no chunks); the harness itself
 * is covered with doubles in search-eval-harness.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { chunkTranscript } from "@/lib/search/chunker"
import { ORTHOGRAPHIC_CATEGORIES, loadCorpus } from "@/lib/search/eval/corpus"
import {
  createLegacyEngine,
  createLexicalEngine,
  createPgliteEngine,
  createReplayEngine,
  loadReplayFixture,
  type EvalEngine,
} from "@/lib/search/eval/engines"
import { runEngine, type EngineReport } from "@/lib/search/eval/run"
import { hebrewPrefixVariants } from "@/lib/search/hebrew-normalize"

const corpus = loadCorpus()
const realPackageA =
  hebrewPrefixVariants("והתקציב").length > 0 &&
  chunkTranscript({ segments: corpus.meetings[0].transcript ?? [], speakers: corpus.meetings[0].speakers ?? [] }).length > 0

describe.runIf(realPackageA)("search eval thresholds (Package A modules)", () => {
  const reports: Record<string, EngineReport> = {}
  let pglite: EvalEngine | null = null

  beforeAll(async () => {
    reports.legacy = await runEngine(corpus, createLegacyEngine(corpus))
    reports.lexical = await runEngine(corpus, createLexicalEngine(corpus))
    pglite = await createPgliteEngine(corpus)
    if (pglite) reports.pglite = await runEngine(corpus, pglite)

    const fixture = loadReplayFixture()

    if (fixture) reports.replay = await runEngine(corpus, createReplayEngine(corpus, fixture))
  }, 180_000)

  afterAll(async () => {
    await pglite?.close?.()
  })

  it("lexical: recall@5 ≥ 0.95 and MRR@10 ≥ 0.8 on the orthographic categories", () => {
    for (const category of ORTHOGRAPHIC_CATEGORIES) {
      expect(reports.lexical.metrics[category].recall5, category).toBeGreaterThanOrEqual(0.95)
      expect(reports.lexical.metrics[category].mrr10, category).toBeGreaterThanOrEqual(0.8)
    }
  })

  it("pglite within 0.05 of lexical on those categories", () => {
    if (!reports.pglite) return

    for (const category of ORTHOGRAPHIC_CATEGORIES) {
      expect(reports.pglite.metrics[category].recall5, category).toBeGreaterThanOrEqual(reports.lexical.metrics[category].recall5 - 0.05)
    }
  })

  it("replay beats lexical on paraphrases when the recorded fixture exists", () => {
    if (!reports.replay) return

    expect(reports.replay.metrics.paraphrase.recall5).toBeGreaterThan(reports.lexical.metrics.paraphrase.recall5)
  })

  it("legacy is reported, not asserted", () => {
    expect(reports.legacy.metrics.overall.n).toBe(corpus.queries.length)
  })
})

describe.skipIf(realPackageA)("search eval thresholds (pending Package A)", () => {
  it("is skipped until A's normalizer and chunker replace the Step 0 stubs", () => {
    expect(realPackageA).toBe(false)
  })
})
