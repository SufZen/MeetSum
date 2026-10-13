import { beforeEach, describe, expect, it } from "vitest"

import type { AskCitation } from "@/lib/ask/types"
import {
  buildAppendMessageSql,
  buildCountQuestionsSql,
  buildCreateThreadSql,
  buildFinalizeMessageSql,
  buildGetThreadSql,
  buildListThreadsSql,
  buildMessagesSql,
  buildSetFeedbackSql,
  buildUpdateThreadSql,
  createMemoryThreadStore,
  createPgThreadStore,
  decodeThreadCursor,
  encodeThreadCursor,
  InvalidThreadCursorError,
  resetMemoryThreadStoreForTesting,
  threadTitleFrom,
  type PgThreadStoreOptions,
} from "@/lib/ask/thread-store"
import { createInMemoryMeetingDatabase, createInMemoryMeetingRepository, type MeetingRecord } from "@/lib/meetings/repository"

/**
 * Thread store (docs/parity/m6.md, C6 tests): user and workspace filters on
 * every statement, the meeting visibility join, soft delete, unavailable
 * citations, and per-user privacy (admins can't read other users' threads).
 */

const options: PgThreadStoreOptions = {
  workspaceId: "ws_a",
  userId: "user_me",
  scope: { kind: "member", workspaceId: "ws_a", userId: "user_me", email: "me@example.com", role: "admin" },
}

function flat(sql: { text: string }) {
  return sql.text.replace(/\s+/g, " ")
}

function bound(sql: { text: string; values: unknown[] }, pattern: RegExp): unknown[] {
  return [...sql.text.matchAll(pattern)].map((match) => sql.values[Number(match[1]) - 1])
}

function expectOwner(sql: { text: string; values: unknown[] }) {
  expect(bound(sql, /t\.workspace_id = \$(\d+)/g)).toContain("ws_a")
  expect(bound(sql, /t\.user_id = \$(\d+)/g)).toEqual(["user_me"])
}

describe("thread SQL builders", () => {
  it("lists only the caller's live threads, with the meeting visibility join and room workspace check", () => {
    const sql = buildListThreadsSql(options, { limit: 10 })
    const text = flat(sql)

    expect(text).toMatch(/where t\.workspace_id = \$1 and t\.user_id = \$2 and t\.deleted_at is null/)
    expectOwner(sql)
    expect(text).toContain("t.scope_kind <> 'meeting' or exists (select 1 from meetings m where m.id = t.meeting_id and (m.workspace_id = $3")
    expect(text).toContain("m.visibility in ('workspace', 'link')")
    expect(text).toContain("x.workspace_id = t.workspace_id")
    expect(text).toContain("t.archived_at is null")
    expect(text).toMatch(/order by sort_at desc, t\.id desc limit 11$/)
  })

  it("filters by scope and caps the page at 50", () => {
    const sql = buildListThreadsSql(options, { scope: { kind: "meeting", meetingId: "m1" }, limit: 500 })

    expect(flat(sql)).toContain("t.scope_kind = 'meeting' and t.meeting_id = $")
    expect(sql.values).toContain("m1")
    expect(sql.limit).toBe(50)
  })

  it("rejects a tampered cursor", () => {
    expect(() => buildListThreadsSql(options, { cursor: "not-a-cursor" })).toThrow(InvalidThreadCursorError)

    const cursor = encodeThreadCursor({ at: "2026-10-01T00:00:00.000Z", id: "thr_1" })

    expect(decodeThreadCursor(cursor)).toEqual({ at: "2026-10-01T00:00:00.000Z", id: "thr_1" })
    expect(flat(buildListThreadsSql(options, { cursor }))).toContain("(coalesce(t.last_message_at, t.created_at), t.id) < (")
  })

  it("scopes get, messages, update, delete, finalize, feedback and count by workspace and user", () => {
    const final = {
      content: "x",
      status: "complete" as const,
      citations: [],
      retrieval: null,
      grounded: true,
      language: "he",
    }
    const statements = [
      buildGetThreadSql(options, "thr_1"),
      buildMessagesSql(options, "thr_1", 200),
      buildUpdateThreadSql(options, "thr_1", { title: "t" }),
      buildUpdateThreadSql(options, "thr_1", { deleted: true }),
      buildFinalizeMessageSql(options, "msg_1", final),
      buildSetFeedbackSql(options, "msg_1", 1),
      buildCountQuestionsSql(options),
    ]

    for (const sql of statements) expectOwner(sql)
    for (const sql of statements.slice(0, 6)) expect(flat(sql)).toContain("t.deleted_at is null")
    expect(flat(buildUpdateThreadSql(options, "thr_1", { deleted: true }))).toContain("deleted_at = now()")
    expect(flat(buildSetFeedbackSql(options, "msg_1", -1))).toContain("cm.role = 'assistant'")
    expect(flat(buildGetThreadSql(options, "thr_1"))).toContain("exists (select 1 from meetings m where m.id = t.meeting_id")
  })

  it("only creates a meeting thread for a meeting the caller can see", () => {
    const sql = buildCreateThreadSql(options, { id: "thr_1", scope: { kind: "meeting", meetingId: "m1" }, title: "t", language: "he" })
    const text = flat(sql)

    expect(text).toContain("where exists (select 1 from meetings m where m.id = $5 and (m.workspace_id = $")
    expect(sql.values.slice(0, 5)).toEqual(["thr_1", "ws_a", "user_me", "meeting", "m1"])

    const room = flat(buildCreateThreadSql(options, { id: "thr_2", scope: { kind: "room", roomId: "ctx_1" }, title: null, language: null }))

    expect(room).toContain("exists (select 1 from contexts x where x.id = $6 and x.workspace_id = $2)")
  })

  it("appends a message only through the caller's thread (atomic count update)", () => {
    const sql = buildAppendMessageSql(options, "thr_1", "msg_1", { role: "user", content: "שאלה", status: "complete" })
    const text = flat(sql)

    expect(text).toMatch(/^with t as \(update chat_threads set message_count = message_count \+ 1/)
    expect(text).toContain("where id = $1 and workspace_id = $2 and user_id = $3 and deleted_at is null")
    expect(text).toContain("from t returning id")
  })

  it("stores no retrieval text: ids and scores only, error codes only", () => {
    const sql = buildFinalizeMessageSql(options, "msg_1", {
      content: "x",
      status: "error",
      citations: [],
      retrieval: { mode: "lexical", chunkIds: ["c1"], scores: [0.5], topSimilarity: null, lexicalHits: 2 },
      grounded: false,
      language: "he",
      error: "llm_unavailable",
    })

    expect(sql.values).toContain(JSON.stringify({ mode: "lexical", chunkIds: ["c1"], scores: [0.5], topSimilarity: null, lexicalHits: 2 }))
    expect(sql.values).toContain("llm_unavailable")
  })

  it("truncates titles to 60 characters", () => {
    expect(threadTitleFrom("א".repeat(80))).toHaveLength(60)
    expect(threadTitleFrom("  short  question ")).toBe("short question")
  })
})

describe("pg thread store", () => {
  it("marks citations of meetings that are no longer visible as unavailable", async () => {
    const citation = (meetingId: string, n: number): AskCitation => ({
      n,
      alias: `s${n}`,
      meetingId,
      meetingTitle: `Title ${meetingId}`,
      segmentId: "seg",
      startMs: 1,
      kind: "transcript",
      quote: "secret quote",
    })
    const queries: string[] = []
    const db = {
      query: async (text: string) => {
        queries.push(text)
        if (text.includes("from chat_threads t where")) {
          return { rows: [{ id: "thr_1", scope_kind: "workspace", meeting_id: null, context_id: null, title: "t", message_count: 2, last_message_at: null, archived_at: null }] }
        }
        if (text.includes("from chat_messages cm")) {
          return {
            rows: [
              { id: "msg_2", role: "assistant", content: "a [s1][s2]", status: "complete", citations: [citation("m_visible", 1), citation("m_private", 2)], grounded: true, language: "he", feedback: null, created_at: new Date("2026-10-01T10:00:01Z") },
              { id: "msg_1", role: "user", content: "q", status: "complete", citations: [], grounded: null, language: "he", feedback: null, created_at: new Date("2026-10-01T10:00:00Z") },
            ],
          }
        }
        if (text.includes("from meetings m where")) return { rows: [{ id: "m_visible" }] }
        return { rows: [] }
      },
    }
    const result = await createPgThreadStore(db, options).getThread("thr_1")

    expect(result?.messages.map((message) => message.id)).toEqual(["msg_1", "msg_2"])
    expect(result?.messages[1].citations[0]).toMatchObject({ meetingId: "m_visible", quote: "secret quote" })
    expect(result?.messages[1].citations[1]).toEqual({
      n: 2,
      alias: "s2",
      meetingId: "m_private",
      kind: "transcript",
      meetingTitle: "",
      quote: "",
      unavailable: true,
    })
    expect(queries.some((text) => text.includes("from meetings m where (m.workspace_id ="))).toBe(true)
  })
})

describe("memory thread store", () => {
  const meetings: MeetingRecord[] = [
    {
      id: "m_shared",
      title: "Shared",
      source: "upload",
      language: "he",
      status: "completed",
      retention: "audio",
      startedAt: "2026-10-01T10:00:00.000Z",
      participants: [],
      workspaceId: "ws_a",
      ownerUserId: "user_owner",
      visibility: "workspace",
    },
    {
      id: "m_private",
      title: "Private",
      source: "upload",
      language: "he",
      status: "completed",
      retention: "audio",
      startedAt: "2026-10-01T10:00:00.000Z",
      participants: [],
      workspaceId: "ws_a",
      ownerUserId: "user_owner",
      visibility: "private",
    },
  ]
  const database = createInMemoryMeetingDatabase(meetings)
  const repoFor = (userId: string, role: "admin" | "member" = "member") =>
    createInMemoryMeetingRepository(database, { kind: "member", workspaceId: "ws_a", userId, email: `${userId}@example.com`, role })

  beforeEach(() => resetMemoryThreadStoreForTesting())

  it("keeps threads private to their user, even from an admin of the same workspace", async () => {
    const mine = createMemoryThreadStore({ workspaceId: "ws_a", userId: "user_me", meetings: repoFor("user_me") })
    const admin = createMemoryThreadStore({ workspaceId: "ws_a", userId: "user_admin", meetings: repoFor("user_admin", "admin") })
    const other = createMemoryThreadStore({ workspaceId: "ws_b", userId: "user_me", meetings: repoFor("user_me") })
    const thread = (await mine.createThread({ scope: { kind: "workspace" }, title: "שאלה פרטית" }))!
    const messageId = (await mine.appendMessage(thread.id, { role: "assistant", content: "a", status: "complete" }))!

    expect(await admin.getThread(thread.id)).toBeNull()
    expect((await admin.listThreads()).threads).toEqual([])
    expect(await admin.appendMessage(thread.id, { role: "user", content: "x", status: "complete" })).toBeNull()
    expect(await admin.setFeedback(messageId, 1)).toBe(false)
    expect(await admin.softDeleteThread(thread.id)).toBe(false)
    expect(await other.getThread(thread.id)).toBeNull()
    expect(await mine.getThread(thread.id)).not.toBeNull()
  })

  it("refuses a meeting thread on a meeting the caller can't see", async () => {
    const store = createMemoryThreadStore({ workspaceId: "ws_a", userId: "user_me", meetings: repoFor("user_me") })

    expect(await store.createThread({ scope: { kind: "meeting", meetingId: "m_private" } })).toBeNull()
    expect(await store.createThread({ scope: { kind: "meeting", meetingId: "m_shared" } })).not.toBeNull()
    expect(await store.createThread({ scope: { kind: "room", roomId: "ctx_missing" } })).toBeNull()
  })

  it("soft-deletes, archives, renames, paginates and counts today's questions", async () => {
    const store = createMemoryThreadStore({ workspaceId: "ws_a", userId: "user_me", meetings: repoFor("user_me") })
    const ids: string[] = []

    for (let index = 0; index < 3; index += 1) {
      const thread = (await store.createThread({ scope: { kind: "workspace" }, title: `q${index}` }))!

      ids.push(thread.id)
      await store.appendMessage(thread.id, { role: "user", content: `q${index}`, status: "complete" })
    }

    const first = await store.listThreads({ limit: 2 })

    expect(first.threads.map((thread) => thread.title)).toEqual(["q2", "q1"])

    const second = await store.listThreads({ limit: 2, cursor: first.nextCursor! })

    expect(second.threads.map((thread) => thread.title)).toEqual(["q0"])
    expect(second.nextCursor).toBeNull()

    expect((await store.renameThread(ids[0], "renamed"))?.title).toBe("renamed")
    expect((await store.archiveThread(ids[1], true))?.archived).toBe(true)
    expect((await store.listThreads()).threads.map((thread) => thread.id)).toEqual([ids[2], ids[0]])
    expect((await store.listThreads({ archived: true })).threads.map((thread) => thread.id)).toEqual([ids[1]])
    expect(await store.softDeleteThread(ids[2])).toBe(true)
    expect(await store.getThread(ids[2])).toBeNull()
    // Deleting threads does not reset the daily cap.
    expect(await store.countUserQuestionsToday()).toBe(3)
  })

  it("returns history oldest first without incomplete answers", async () => {
    const store = createMemoryThreadStore({ workspaceId: "ws_a", userId: "user_me", meetings: repoFor("user_me") })
    const thread = (await store.createThread({ scope: { kind: "workspace" } }))!

    await store.appendMessage(thread.id, { role: "user", content: "q1", status: "complete" })
    await store.appendMessage(thread.id, { role: "assistant", content: "a1", status: "complete" })
    await store.appendMessage(thread.id, { role: "user", content: "q2", status: "complete" })
    await store.appendMessage(thread.id, { role: "assistant", content: "partial", status: "aborted" })

    expect(await store.getHistory(thread.id, 10)).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
    ])
  })
})
