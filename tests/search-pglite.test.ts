/**
 * Real Postgres semantics (PGlite + pg_trgm, no pgvector): migration 025
 * applies without vector and is idempotent; the pg engine's scoped SQL legs
 * find Hebrew prefix forms, run the trigram leg, fuse, and never return W2 or
 * private-invisible meetings. Skipped if PGlite cannot load on this host.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/search/hebrew-normalize", async () => (await import("./helpers/search-doubles")).normalizerDouble)
vi.mock("@/lib/search/chunker", async () => (await import("./helpers/search-doubles")).chunkerDouble)
vi.mock("@/lib/search/chunk-sources", async () => (await import("./helpers/search-doubles")).chunkSourcesDouble)

import type { MeetingRepository, RepoScope } from "@/lib/meetings/repository"
import { createPgliteSearchDb, reapplyMigration025, seedPgliteMeetings, type PgliteSearchDb } from "@/lib/search/eval/pglite"
import { defaultChunkMeeting } from "@/lib/search/memory-engine"
import { createPgSearchEngine } from "@/lib/search/pg-engine"
import { retrievePassages } from "@/lib/search/retrieve"
import { rankCandidates, searchWorkspace, setSearchEngineForTesting, type SearchEngine } from "@/lib/search/service"
import type { SearchContext } from "@/lib/search/types"

import { COLLIDING_TERM, searchCorpus } from "./helpers/search-fixtures"

let db: PgliteSearchDb | null = null
let engine: SearchEngine

beforeAll(async () => {
  db = await createPgliteSearchDb()
  if (!db) return

  const meetings = searchCorpus().map((meeting) =>
    meeting.id === "m_budget"
      ? {
          ...meeting,
          participantDetails: [
            { id: "p1", meetingId: meeting.id, name: "דנה כהן", email: "other@a.com", role: "organizer" as const, source: "manual" as const, attendanceStatus: "accepted" as const, createdAt: "", updatedAt: "" },
          ],
        }
      : meeting
  )

  await seedPgliteMeetings(db, meetings, defaultChunkMeeting)
  engine = createPgSearchEngine({
    client: db.client,
    capabilities: async () => ({
      vector: { available: false, tableReady: false, indexReady: false },
      trgm: { installed: true, hebrew: db!.hebrewTrigrams },
      embeddingKey: null,
      checkedAt: "now",
    }),
  })
}, 120_000)

afterAll(async () => {
  setSearchEngineForTesting(undefined)
  await db?.close()
})

function ctx(scope: RepoScope): SearchContext {
  return { scope, workspaceId: scope.workspaceId, principalKey: "k", meetings: {} as MeetingRepository }
}

const member: RepoScope = { kind: "member", workspaceId: "ws_a", userId: "user_x", email: "x@a.com", role: "admin" }
const viewer: RepoScope = { kind: "member", workspaceId: "ws_a", userId: "user_v", email: "v@a.com", role: "viewer" }
const owner: RepoScope = { kind: "member", workspaceId: "ws_a", userId: "user_owner", email: "owner@a.com", role: "owner" }
const keyOrphan: RepoScope = { kind: "api_key", workspaceId: "ws_a" }
const keyOwned: RepoScope = { kind: "api_key", workspaceId: "ws_a", ownerUserId: "user_owner" }
const w2: RepoScope = { kind: "member", workspaceId: "ws_b", userId: "user_w2", email: "w2@b.com", role: "owner" }

async function meetingIds(scope: RepoScope, q: string, filters = {}) {
  const ranked = await rankCandidates(ctx(scope), { q, filters, task: "RETRIEVAL_QUERY", engine })

  return [...new Set(ranked.candidates.map((candidate) => candidate.chunk.meetingId))].sort()
}

describe("search on PGlite", () => {
  it("migration 025 applied without pgvector and re-applies idempotently", async () => {
    if (!db) return

    const tables = (await db.client.query(
      "select to_regclass('meeting_chunks') as chunks, to_regclass('meeting_chunk_embeddings') as embeddings, to_regclass('chat_threads') as threads"
    )).rows[0] as Record<string, unknown>

    expect(tables).toEqual({ chunks: "meeting_chunks", embeddings: null, threads: "chat_threads" })
    await expect(reapplyMigration025(db)).resolves.toBeUndefined()
  })

  it("FTS finds Hebrew prefix forms; trigram finds a near-miss Latin token", async () => {
    if (!db) return

    expect(await meetingIds(member, "תקציב")).toEqual(["m_budget", "m_hiring"])
    expect(await meetingIds(member, "בהתקציב")).toContain("m_budget")
    if (db.hebrewTrigrams) expect(await meetingIds(member, "supabse")).toEqual(["m_budget"])
  })

  it("visibility holds in real SQL for members, viewers, API keys, owners and W2", async () => {
    if (!db) return

    expect(await meetingIds(member, COLLIDING_TERM)).toEqual(["m_budget"])
    expect(await meetingIds(viewer, COLLIDING_TERM)).toEqual(["m_budget"])
    expect(await meetingIds(keyOrphan, COLLIDING_TERM)).toEqual(["m_budget"])
    expect(await meetingIds(keyOwned, COLLIDING_TERM)).toEqual(["m_budget", "m_private"])
    expect(await meetingIds(owner, COLLIDING_TERM)).toEqual(["m_budget", "m_private"])
    expect(await meetingIds(w2, COLLIDING_TERM)).toEqual(["m_w2"])
    expect(await meetingIds(w2, COLLIDING_TERM, { meetingIds: ["m_budget", "m_private"] })).toEqual([])
  })

  it("a participant email grants a private meeting to that member only", async () => {
    if (!db) return

    await db.client.query("update meetings set visibility = 'private' where id = 'm_budget'")

    try {
      expect(await meetingIds({ ...member, email: "OTHER@a.com" }, COLLIDING_TERM)).toEqual(["m_budget"])
      expect(await meetingIds(member, COLLIDING_TERM)).toEqual([])
    } finally {
      await db.client.query("update meetings set visibility = 'workspace' where id = 'm_budget'")
    }
  })

  it("filters run as bound parameters against the real schema", async () => {
    if (!db) return

    expect(await meetingIds(member, "תקציב", { roomIds: ["room_hr"] })).toEqual(["m_hiring"])
    expect(await meetingIds(member, "תקציב", { tags: ["FINANCE"] })).toEqual(["m_budget"])
    expect(await meetingIds(member, "תקציב", { from: "2026-08-15" })).toEqual(["m_budget"])
    expect(await meetingIds(member, "תקציב", { to: "2026-08-01" })).toEqual(["m_hiring"])
    expect(await meetingIds(member, "תקציב", { participants: ["דנה כהן"] })).toEqual(["m_budget"])
    expect(await meetingIds(member, "תקציב", { meetingTypes: ["board"], kinds: ["transcript"], speakerIds: ["spk_dana"] })).toEqual(["m_budget"])
    expect(await meetingIds(member, "x'); drop table meetings; --")).toEqual([])
  })

  it("accepts the statement_timeout and recovers from a failed FTS leg via its savepoint (real Postgres)", async () => {
    if (!db) return

    const statements: string[] = []
    const real = db.client
    // A real Postgres error inside the FTS leg aborts the transaction; the
    // savepoint must bring it back so the trigram leg still runs.
    const query = async (text: string, values?: unknown[]) => {
      statements.push(text)

      return text.includes("ts_rank_cd") ? real.query("select 1/0", []) : real.query(text, values)
    }
    const breaking = createPgSearchEngine({
      client: { query },
      capabilities: async () => ({
        vector: { available: false, tableReady: false, indexReady: false },
        trgm: { installed: true, hebrew: true },
        embeddingKey: null,
        checkedAt: "now",
      }),
    })
    const ranked = await rankCandidates(ctx(member), { q: "supabse", filters: {}, task: "RETRIEVAL_QUERY", engine: breaking })

    expect(statements).toContain("set local statement_timeout = 5000")
    expect(statements).toContain("rollback to savepoint search_fts_leg")
    expect(statements.indexOf("commit")).toBeGreaterThan(statements.indexOf("rollback to savepoint search_fts_leg"))
    expect(statements).not.toContain("rollback")
    if (db.hebrewTrigrams) expect(ranked.candidates.map((candidate) => candidate.chunk.meetingId)).toContain("m_budget")
  })

  it("does not count meetings without a transcript or summary as pending (no permanent banner)", async () => {
    if (!db) return

    await db.client.query(
      "insert into meetings (id, title, source, status, started_at, workspace_id, search_index_state) values ('m_empty', 'Empty', 'upload', 'completed', now(), 'ws_a', 'pending')"
    )

    try {
      expect(await engine.countPending(ctx(member), {})).toBe(0)

      await db.client.query(
        "insert into transcript_segments (id, meeting_id, start_ms, end_ms, text) values ('m_empty_s1', 'm_empty', 0, 1000, 'שלום')"
      )
      expect(await engine.countPending(ctx(member), {})).toBe(1)
    } finally {
      await db.client.query("delete from meetings where id = 'm_empty'")
    }
  })

  it("serves searchWorkspace, facets, pending counts and retrieve end to end", async () => {
    if (!db) return

    setSearchEngineForTesting(engine)

    const response = await searchWorkspace(ctx(member), { q: "תקציב", filters: {}, group: "meeting", limit: 10, hitsPerMeeting: 10 })

    expect(response.mode).toBe("lexical")
    expect(response.indexCoverage).toEqual({ pending: 0 })
    expect(response.groups?.[0].meeting).toMatchObject({ id: "m_budget", meetingType: "board", rooms: [{ id: "room_fin", name: "כספים" }], tags: ["finance"] })

    const facets = await engine.facets(ctx(member))

    expect(facets.rooms.map((room) => room.id).sort()).toEqual(["room_fin", "room_hr"])
    expect(JSON.stringify(facets)).not.toContain("Workspace B")

    const retrieved = await retrievePassages(ctx(member), { question: COLLIDING_TERM, scope: { kind: "workspace" } }, { engine, env: {} })

    expect(retrieved.passages.map((passage) => passage.chunk.meetingId)).toEqual(["m_budget"])
    expect(Object.values(retrieved.passages[0].segmentTexts).join(" ")).toContain(COLLIDING_TERM)
  })
})
