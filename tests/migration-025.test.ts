import { readFileSync } from "node:fs"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { chunkTranscript } from "@/lib/search/chunker"
import { createIndexStore } from "@/lib/search/index-store"
import { detectSearchCapabilities } from "@/lib/search/capabilities"
import { vectorSetupStatements } from "@/lib/search/vector-ddl"

const SQL = readFileSync("db/migrations/025_search_ask.sql", "utf8")
const flat = SQL.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").toLowerCase()

describe("migration 025 (static)", () => {
  it("always creates pg_trgm, the chunk table, FTS and trigram indexes", () => {
    expect(flat).toContain("create extension if not exists pg_trgm")
    expect(flat).toContain("create table if not exists meeting_chunks")
    expect(flat).toContain("setweight(to_tsvector('simple', text_norm), 'a')")
    expect(flat).toContain("setweight(to_tsvector('simple', text_stem), 'b')")
    expect(flat).toContain("using gin (tsv)")
    expect(flat).toContain("using gin (text_norm gin_trgm_ops)")
  })

  it("installs vector objects only inside the guarded DO block (no static vector type)", () => {
    const outsideDo = flat.replace(/do \$\$.*?end \$\$;/g, "")

    expect(outsideDo).not.toMatch(/\bvector\b/)
    for (const statement of vectorSetupStatements({ model: "gemini-embedding-001", dimensions: 1536 })) {
      expect(flat).toContain(statement.replace(/\s+/g, " ").toLowerCase())
    }
  })

  it("adds the meeting index-state columns used by the indexer and sweeper", () => {
    for (const column of [
      "meeting_type",
      "search_index_state",
      "search_index_mode",
      "search_embedding_key",
      "search_indexed_at",
      "search_indexed_version",
      "search_requested_at",
      "search_index_error",
    ]) {
      expect(flat).toContain(`add column if not exists ${column}`)
    }
  })
})

describe("db/schema.sql mirrors 025 (and keeps M7's 024)", () => {
  const schema = readFileSync("db/schema.sql", "utf8")
    .replace(/--[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase()

  it("creates the chunk, thread and message tables with their indexes", () => {
    for (const fragment of [
      "create extension if not exists pg_trgm",
      "create table if not exists meeting_chunks",
      "using gin (tsv)",
      "using gin (text_norm gin_trgm_ops)",
      "create table if not exists chat_threads",
      "create table if not exists chat_messages",
      "idx_meetings_search_stale",
      "idx_meetings_meeting_type",
    ]) {
      expect(schema).toContain(fragment)
    }
  })

  it("declares the meeting index-state columns", () => {
    for (const column of [
      "meeting_type text",
      "search_index_state text not null default 'pending'",
      "meetings_search_index_state_check",
      "search_index_mode text",
      "search_embedding_key text",
      "search_indexed_at timestamptz",
      "search_indexed_version integer",
      "search_requested_at timestamptz",
      "search_index_error text",
    ]) {
      expect(schema).toContain(column)
    }
  })

  it("keeps vector objects behind the pgvector guard", () => {
    const outsideDo = schema.replace(/do \$\$.*?end \$\$;/g, "")

    expect(outsideDo).not.toMatch(/vector/)
    for (const statement of vectorSetupStatements({ model: "gemini-embedding-001", dimensions: 1536 })) {
      expect(schema).toContain(statement.replace(/\s+/g, " ").toLowerCase())
    }
  })

  it("keeps the M7 bot tables", () => {
    expect(schema).toContain("create table if not exists bot_sessions")
    expect(schema).toContain("create table if not exists bot_events")
  })
})

/** Just enough of the M2–M5 schema for 025's foreign keys. */
const BASE_SCHEMA = `
  create table workspaces (id text primary key, deleted_at timestamptz, created_at timestamptz not null default now());
  create table users (id text primary key);
  create table contexts (id text primary key, workspace_id text references workspaces(id));
  create table meetings (
    id text primary key,
    workspace_id text not null references workspaces(id),
    title text not null default '',
    started_at timestamptz not null default now(),
    transcript_version integer not null default 0
  );
`

type PGliteLike = {
  exec(sql: string): Promise<unknown>
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>
  close(): Promise<void>
}

let db: PGliteLike | undefined
let loadError: unknown

beforeAll(async () => {
  try {
    const { PGlite } = await import("@electric-sql/pglite")
    const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm")

    db = (await PGlite.create({ extensions: { pg_trgm } })) as unknown as PGliteLike
    await db.exec(BASE_SCHEMA)
  } catch (error) {
    loadError = error
  }
}, 60_000)

afterAll(async () => {
  await db?.close()
})

const queryable = () => ({
  query: (text: string, values?: unknown[]) => (db as PGliteLike).query(text, values),
})

describe("migration 025 on PGlite without pgvector", () => {
  it("applies, creates the chunk tables and no vector objects, and re-runs idempotently", async (context) => {
    if (!db) {
      context.skip(`PGlite did not load: ${String(loadError)}`)
      return
    }

    await db.exec(SQL)
    await db.exec(SQL)

    const tables = await db.query(
      "select to_regclass('meeting_chunks') is not null as chunks, to_regclass('chat_threads') is not null as threads, to_regclass('chat_messages') is not null as messages, to_regclass('meeting_chunk_embeddings') is not null as embeddings"
    )

    expect(tables.rows[0]).toEqual({ chunks: true, threads: true, messages: true, embeddings: false })
    const extensions = await db.query("select extname from pg_extension order by extname")

    expect(extensions.rows.map((row) => (row as { extname: string }).extname)).toContain("pg_trgm")
    expect(extensions.rows.map((row) => (row as { extname: string }).extname)).not.toContain("vector")

    const caps = await detectSearchCapabilities(queryable(), { model: "gemini-embedding-001", dimensions: 1536 })

    expect(caps.vector).toMatchObject({ available: false, tableReady: false, indexReady: false, reason: "vector_unavailable" })
    expect(caps.trgm.installed).toBe(true)
  })

  it("accepts the index store's lexical write and finds prefixed Hebrew through FTS", async (context) => {
    if (!db) {
      context.skip(`PGlite did not load: ${String(loadError)}`)
      return
    }

    await db.exec("insert into workspaces (id) values ('ws_1'); insert into meetings (id, workspace_id, transcript_version) values ('m1', 'ws_1', 2)")
    const chunks = chunkTranscript({
      segments: [
        { id: "s1", speaker: "דנה", speakerId: undefined, turnIndex: 0, startMs: 0, endMs: 1_000, text: "אישרנו את והתקציב לרבעון" },
        { id: "s2", speaker: "Avi", turnIndex: 1, startMs: 1_000, endMs: 2_000, text: "We moved to Supabase" },
      ],
      speakers: [],
      meetingLanguage: "he",
    })
    const store = createIndexStore(queryable())

    await store.writeIndex({
      workspaceId: "ws_1",
      meetingId: "m1",
      expectedVersion: 2,
      chunks,
      key: null,
      vectorTable: false,
      vectors: [],
      coversAllChunks: false,
      mode: "lexical",
      meetingType: "budget_review",
      startedAt: new Date("2026-10-13T10:00:00.000Z"),
    })

    const meeting = await db.query(
      "select search_index_state, search_index_mode, search_embedding_key, meeting_type, search_indexed_version from meetings where id = 'm1'"
    )

    expect(meeting.rows[0]).toEqual({
      search_index_state: "ready",
      search_index_mode: "lexical",
      search_embedding_key: null,
      meeting_type: "budget_review",
      search_indexed_version: 2,
    })

    const stored = await db.query(
      "select segment_ids, segment_start_ms, speaker_ids from meeting_chunks where meeting_id = 'm1'"
    )

    expect(stored.rows[0]).toEqual({ segment_ids: ["s1", "s2"], segment_start_ms: [0, 1_000], speaker_ids: [] })

    // Raw query token at weight A plus its prefix-stripped variant at weight B.
    const hits = await db.query(
      "select count(*)::int as count from meeting_chunks where workspace_id = $1 and tsv @@ to_tsquery('simple', $2)",
      ["ws_1", "תקציב"]
    )

    expect(hits.rows[0]).toEqual({ count: 1 })

    await store.markSkipped("ws_1", "m1")
    const after = await db.query("select count(*)::int as count from meeting_chunks where meeting_id = 'm1'")

    expect(after.rows[0]).toEqual({ count: 0 })
  })
})
