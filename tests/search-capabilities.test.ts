import { afterEach, describe, expect, it, vi } from "vitest"

import { setEmbeddingProviderForTesting } from "@/lib/ai/embeddings"
import {
  describeSearchCapabilities,
  detectSearchCapabilities,
  getSearchCapabilities,
  indexMatchesKey,
  resetSearchCapabilitiesForTesting,
} from "@/lib/search/capabilities"

const KEY = { model: "gemini-embedding-001", dimensions: 1536 }
const HNSW_DEF =
  "CREATE INDEX idx_mce_hnsw_gemini_embedding_001_1536 ON public.meeting_chunk_embeddings USING hnsw (((embedding)::vector(1536)) vector_cosine_ops) WITH (m='16', ef_construction='64') WHERE ((model = 'gemini-embedding-001'::text) AND (dimensions = 1536))"

type FakeState = {
  available?: string | null
  installed?: string | null
  tableReady?: boolean
  trgm?: string | null
  hebrewTrigrams?: number
  indexdefs?: string[]
}

function fakeDb(state: FakeState) {
  return {
    query: vi.fn(async (text: string) => {
      if (text.includes("pg_available_extensions")) {
        return {
          rows: [
            {
              available: state.available ?? null,
              installed: state.installed ?? null,
              table_ready: state.tableReady ?? false,
              trgm: state.trgm ?? null,
            },
          ],
        }
      }
      if (text.includes("show_trgm")) return { rows: [{ count: state.hebrewTrigrams ?? 0 }] }
      if (text.includes("pg_indexes")) return { rows: (state.indexdefs ?? []).map((indexdef) => ({ indexdef })) }
      throw new Error(`unexpected query: ${text}`)
    }),
  }
}

afterEach(() => {
  resetSearchCapabilitiesForTesting()
  setEmbeddingProviderForTesting(undefined)
  vi.unstubAllEnvs()
})

describe("detectSearchCapabilities", () => {
  it("reports pgvector absent (lexical) with pg_trgm and Hebrew trigrams", async () => {
    const caps = await detectSearchCapabilities(fakeDb({ trgm: "1.6", hebrewTrigrams: 6 }), KEY)

    expect(caps.vector).toEqual({ available: false, tableReady: false, indexReady: false, reason: "vector_unavailable" })
    expect(caps.trgm).toEqual({ installed: true, hebrew: true })
    expect(caps.embeddingKey).toEqual(KEY)
  })

  it("reports a pgvector older than 0.8", async () => {
    const caps = await detectSearchCapabilities(fakeDb({ available: "0.7.4", installed: "0.7.4", trgm: "1.6" }), KEY)

    expect(caps.vector).toMatchObject({ available: false, installedVersion: "0.7.4", reason: "vector_too_old" })
  })

  it("reports an available but not installed extension", async () => {
    const caps = await detectSearchCapabilities(fakeDb({ available: "0.8.1" }), KEY)

    expect(caps.vector).toMatchObject({ available: false, reason: "vector_not_installed" })
  })

  it("reports the table present without the active key's index", async () => {
    const caps = await detectSearchCapabilities(
      fakeDb({
        available: "0.8.1",
        installed: "0.8.1",
        tableReady: true,
        trgm: "1.6",
        hebrewTrigrams: 6,
        indexdefs: [HNSW_DEF.replaceAll("1536", "768")],
      }),
      KEY
    )

    expect(caps.vector).toEqual({
      available: true,
      installedVersion: "0.8.1",
      tableReady: true,
      indexReady: false,
      reason: "index_missing",
    })
  })

  it("reports vector ready", async () => {
    const caps = await detectSearchCapabilities(
      fakeDb({ available: "0.8.1", installed: "0.8.1", tableReady: true, trgm: "1.6", hebrewTrigrams: 6, indexdefs: [HNSW_DEF] }),
      KEY
    )

    expect(caps.vector).toEqual({ available: true, installedVersion: "0.8.1", tableReady: true, indexReady: true })
    expect(describeSearchCapabilities(caps)).toBe(
      "[search] capabilities: mode=hybrid vector=ready trgm=hebrew embedding=gemini-embedding-001:1536"
    )
  })

  it("reports no embedding provider while the table is ready", async () => {
    const caps = await detectSearchCapabilities(
      fakeDb({ available: "0.8.1", installed: "0.8.1", tableReady: true, indexdefs: [HNSW_DEF] }),
      null
    )

    expect(caps.vector).toMatchObject({ tableReady: true, indexReady: false, reason: "no_embedding_provider" })
    expect(caps.embeddingKey).toBeNull()
  })

  it("reports no Hebrew trigrams (C locale) and a missing pg_trgm", async () => {
    expect((await detectSearchCapabilities(fakeDb({ trgm: "1.6", hebrewTrigrams: 0 }), KEY)).trgm).toEqual({
      installed: true,
      hebrew: false,
    })

    const db = fakeDb({})
    const caps = await detectSearchCapabilities(db, KEY)

    expect(caps.trgm).toEqual({ installed: false, hebrew: false })
    expect(db.query.mock.calls.some(([text]) => String(text).includes("show_trgm"))).toBe(false)
    expect(describeSearchCapabilities(caps)).toContain("trgm=missing")
  })

  it("never throws: a failing database reports everything unavailable", async () => {
    const caps = await detectSearchCapabilities({ query: vi.fn().mockRejectedValue(new Error("down")) }, KEY)

    expect(caps.vector).toMatchObject({ available: false, indexReady: false, reason: "detection_failed" })
    expect(caps.trgm).toEqual({ installed: false, hebrew: false })
  })
})

describe("indexMatchesKey", () => {
  it("needs hnsw plus the exact model and dimensions", () => {
    expect(indexMatchesKey(HNSW_DEF, KEY)).toBe(true)
    expect(indexMatchesKey(HNSW_DEF, { ...KEY, dimensions: 153 })).toBe(false)
    expect(indexMatchesKey(HNSW_DEF.replace("(dimensions = 1536)", "(dimensions = 15360)"), KEY)).toBe(false)
    expect(indexMatchesKey(HNSW_DEF.replace("hnsw", "btree"), KEY)).toBe(false)
    expect(indexMatchesKey(HNSW_DEF, { model: "gemini-embedding-002", dimensions: 1536 })).toBe(false)
  })
})

describe("getSearchCapabilities", () => {
  it("degrades cleanly without Postgres and carries the active key", async () => {
    vi.stubEnv("MEETSUM_STORAGE", "memory")
    setEmbeddingProviderForTesting(null)

    const caps = await getSearchCapabilities()

    expect(caps.vector).toMatchObject({ available: false, indexReady: false, reason: "no_database" })
    expect(caps.trgm.hebrew).toBe(false)
    expect(caps.embeddingKey).toBeNull()
  })
})
