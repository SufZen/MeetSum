import { readFileSync } from "node:fs"

import { describe, expect, it, vi } from "vitest"

import {
  embeddingKeyPredicate,
  ensureVectorSupport,
  isSupportedPgvectorVersion,
  vectorIndexName,
  vectorSetupStatements,
} from "@/lib/search/vector-ddl"

const flat = (sql: string) => sql.replace(/\s+/g, " ").trim().toLowerCase()
const migration = flat(readFileSync("db/migrations/025_search_ask.sql", "utf8"))
const DEFAULT_KEY = { model: "gemini-embedding-001", dimensions: 1536 }

function recorder(row: Record<string, unknown>) {
  const calls: string[] = []
  const db = {
    query: vi.fn(async (text: string) => {
      calls.push(flat(text))
      return { rows: text.includes("pg_available_extensions") ? [row] : [] }
    }),
  }

  return { db, calls }
}

describe("vector DDL", () => {
  it("matches the vector block of migration 025 for the default key (static)", () => {
    const statements = vectorSetupStatements(DEFAULT_KEY).map(flat)

    expect(statements[0]).toBe("create extension if not exists vector")
    for (const statement of statements) expect(migration).toContain(statement)
    expect(vectorIndexName(DEFAULT_KEY)).toBe("idx_mce_hnsw_gemini_embedding_001_1536")
  })

  it("builds a partial index with literal model and dimensions for another key", () => {
    const index = flat(vectorSetupStatements({ model: "gemini-embedding-001", dimensions: 768 })[3])

    expect(index).toBe(
      "create index if not exists idx_mce_hnsw_gemini_embedding_001_768 on meeting_chunk_embeddings using hnsw ((embedding::vector(768)) vector_cosine_ops) with (m = 16, ef_construction = 64) where model = 'gemini-embedding-001' and dimensions = 768"
    )
    expect(embeddingKeyPredicate(DEFAULT_KEY, "e")).toBe("e.model = 'gemini-embedding-001' and e.dimensions = 1536")
  })

  it("rejects keys that could inject SQL", () => {
    for (const key of [
      { model: "x'; drop table meetings; --", dimensions: 1536 },
      { model: "Gemini", dimensions: 1536 },
      { model: "gemini-embedding-001", dimensions: 0 },
      { model: "gemini-embedding-001", dimensions: 2001 },
      { model: "gemini-embedding-001", dimensions: 1.5 },
    ]) {
      expect(() => vectorSetupStatements(key)).toThrow(/Invalid embedding/)
      expect(() => vectorIndexName(key)).toThrow(/Invalid embedding/)
      expect(() => embeddingKeyPredicate(key)).toThrow(/Invalid embedding/)
    }
  })

  it("compares pgvector versions like 025 does", () => {
    expect(isSupportedPgvectorVersion("0.8.1")).toBe(true)
    expect(isSupportedPgvectorVersion("0.8.0")).toBe(true)
    expect(isSupportedPgvectorVersion("0.10.0")).toBe(true)
    expect(isSupportedPgvectorVersion("1.0.0-dev")).toBe(true)
    expect(isSupportedPgvectorVersion("0.7.4")).toBe(false)
    expect(isSupportedPgvectorVersion(undefined)).toBe(false)
  })
})

describe("ensureVectorSupport", () => {
  it("installs the extension, table and key index when pgvector >= 0.8 is available", async () => {
    const { db, calls } = recorder({ available: "0.8.1", installed: null })

    await expect(ensureVectorSupport(db, DEFAULT_KEY)).resolves.toEqual({ enabled: true })
    expect(calls.slice(1)).toEqual(vectorSetupStatements(DEFAULT_KEY).map(flat))
  })

  it("changes nothing when pgvector is unavailable or too old", async () => {
    const missing = recorder({ available: null, installed: null })

    await expect(ensureVectorSupport(missing.db, DEFAULT_KEY)).resolves.toEqual({
      enabled: false,
      reason: "vector_unavailable",
    })
    expect(missing.calls).toHaveLength(1)

    const old = recorder({ available: "0.8.0", installed: "0.7.0" })

    await expect(ensureVectorSupport(old.db, DEFAULT_KEY)).resolves.toEqual({ enabled: false, reason: "vector_too_old" })
    expect(old.calls).toHaveLength(1)
  })

  it("validates the key before touching the database", async () => {
    const { db } = recorder({ available: "0.8.1" })

    await expect(ensureVectorSupport(db, { model: "x'; drop", dimensions: 1 })).rejects.toThrow(/Invalid embedding/)
    expect(db.query).not.toHaveBeenCalled()
  })
})
