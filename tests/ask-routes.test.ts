import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/** Ask routes (docs/parity/m6.md, C8 tests). */

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authz")>()
  const { mockAuthzModule } = await import("./helpers/route-ctx")

  return mockAuthzModule(actual)
})

const recordAuditLog = vi.hoisted(() => vi.fn(async (input: unknown) => input))

vi.mock("@/lib/audit", () => ({ recordAuditLog }))

import { POST as feedbackRoute } from "@/app/api/ask/messages/[id]/feedback/route"
import { POST as askRoute } from "@/app/api/ask/route"
import { DELETE as deleteThread, GET as getThread, PATCH as patchThread } from "@/app/api/ask/threads/[id]/route"
import { GET as listThreads, POST as createThread } from "@/app/api/ask/threads/route"
import { POST as meetingAsk } from "@/app/api/meetings/[id]/ask/route"
import { POST as memoryAsk } from "@/app/api/memory/ask/route"
import { POST as roomAsk } from "@/app/api/rooms/[id]/ask/route"
import type { LlmStreamEvent } from "@/lib/ai/llm/types"
import { resetAskCountersForTesting, setAskDepsForTesting } from "@/lib/ask/service"
import { resetMemoryThreadStoreForTesting } from "@/lib/ask/thread-store"
import type { RetrievedPassage } from "@/lib/search/types"
import { createInMemoryMeetingDatabase, type InMemoryMeetingDatabase } from "@/lib/meetings/repository"
import { setRateLimitStoreForTesting } from "@/lib/rate-limit"

import { createTestCtx, jsonRequest, routeParams, setRouteCtx, testMeeting } from "./helpers/route-ctx"

const ROOM = { id: "ctx_room", name: "Board", createdAt: "2026-10-01T00:00:00Z" }
const BIG = Array.from({ length: 3 }, (_, index) => ({ id: `seg_${index}`, speaker: "דנה", startMs: index, endMs: index + 1, text: "x" }))

let database: InMemoryMeetingDatabase

function passage(meetingId: string): RetrievedPassage {
  return {
    chunk: {
      id: `c_${meetingId}`,
      workspaceId: "ws_a",
      meetingId,
      transcriptVersion: 1,
      kind: "transcript",
      chunkIndex: 0,
      segmentIds: ["seg_q"],
      segmentStartMs: [42_000],
      segmentOffsets: [0],
      overlapCount: 0,
      speakerIds: [],
      text: "התקציב אושר",
      textNorm: "",
      textStem: "",
      tokenEstimate: 5,
      contentHash: "h",
    },
    meetingTitle: "סקירת תקציב",
    meetingStartedAt: "2026-10-01T10:00:00.000Z",
    speakerNames: {},
    segmentTexts: { seg_q: "התקציב אושר" },
    score: 0.9,
  }
}

async function* answer(): AsyncGenerator<LlmStreamEvent> {
  yield { type: "delta", text: "התקציב אושר [s1]." }
  yield {
    type: "done",
    provider: "gemini",
    model: "gemini-3.8-flash",
    text: "התקציב אושר [s1].",
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    costUsd: 0,
    latencyMs: 1,
    attempts: [],
  }
}

function askRequest(body: unknown, accept?: string) {
  return new Request("http://localhost/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json", ...(accept ? { accept } : {}) },
    body: JSON.stringify(body),
  })
}

async function member(userId = "user_me", workspaceId = "ws_a") {
  return createTestCtx({ database, userId, email: `${userId}@example.com`, workspaceId, role: "member" })
}

beforeEach(() => {
  database = createInMemoryMeetingDatabase([
    testMeeting({ id: "m1", title: "סקירת תקציב", contexts: [ROOM], transcript: BIG }),
    testMeeting({ id: "m_private", visibility: "private", ownerUserId: "user_owner", transcript: BIG }),
    testMeeting({ id: "m_w2", workspaceId: "ws_b", transcript: BIG }),
  ])
  database.contexts.set(ROOM.id, ROOM)
  database.contextWorkspaces.set(ROOM.id, "ws_a")
  setRateLimitStoreForTesting(new Map())
  resetAskCountersForTesting()
  resetMemoryThreadStoreForTesting()
  recordAuditLog.mockClear()
  delete process.env.MEETSUM_STORAGE
  process.env.MEETSUM_ASK_FULL_TRANSCRIPT_TOKENS = "0"
  setAskDepsForTesting({
    retrieve: async () => ({ passages: [passage("m1")], mode: "hybrid", topSimilarity: 0.9, lexicalHits: 1 }),
    stream: answer,
    settings: async () => ({}),
  })
})

afterEach(() => {
  setAskDepsForTesting(undefined)
  setRateLimitStoreForTesting(undefined)
  setRouteCtx(undefined)
  delete process.env.MEETSUM_ASK_FULL_TRANSCRIPT_TOKENS
})

describe("POST /api/ask", () => {
  it("streams SSE frames with the SSE headers by default", async () => {
    setRouteCtx(await member())

    const response = await askRoute(askRequest({ question: "מה הוחלט?", scope: { kind: "workspace" } }), routeParams({}))

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8")
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform")
    expect(response.headers.get("x-accel-buffering")).toBe("no")
    expect(response.headers.get("x-ratelimit-limit")).toBe("20")

    const text = await response.text()
    const types = [...text.matchAll(/^event: (\w+)$/gm)].map((match) => match[1])

    expect(types).toEqual(["thread", "context", "delta", "done"])
    expect(text).toMatch(/event: done\ndata: \{"type":"done","status":"complete"/)
  })

  it("returns AskJsonResponse for Accept: application/json", async () => {
    setRouteCtx(await member())

    const response = await askRoute(askRequest({ question: "What was approved?", scope: { kind: "workspace" } }, "application/json"), routeParams({}))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ status: "complete", content: "התקציב אושר [s1].", grounded: true, language: "en" })
    expect(body.citations[0]).toMatchObject({ n: 1, meetingId: "m1", segmentId: "seg_q", startMs: 42_000 })
    expect(body.threadId).toMatch(/^thr_/)
  })

  it("keeps API keys stateless", async () => {
    setRouteCtx(await createTestCtx({ database, principal: "api_key" }))

    const body = await (await askRoute(askRequest({ question: "q?", scope: { kind: "workspace" }, persist: true }, "application/json"), routeParams({}))).json()

    expect(body.threadId).toBeNull()
  })

  it("validates the body", async () => {
    setRouteCtx(await member())

    for (const body of [
      {},
      { question: "", scope: { kind: "workspace" } },
      { question: "x".repeat(2001), scope: { kind: "workspace" } },
      { question: "q", scope: { kind: "meeting" } },
      { question: "q", scope: { kind: "galaxy" } },
      { question: "q", scope: { kind: "workspace" }, language: "fr" },
    ]) {
      expect((await askRoute(askRequest(body), routeParams({}))).status).toBe(400)
    }
  })

  it("answers 404 for an invisible meeting, another workspace's meeting and a foreign room", async () => {
    setRouteCtx(await member())

    for (const scope of [
      { kind: "meeting", meetingId: "m_private" },
      { kind: "meeting", meetingId: "m_w2" },
      { kind: "room", roomId: "ctx_other" },
    ]) {
      const response = await askRoute(askRequest({ question: "q", scope }), routeParams({}))

      expect(response.status).toBe(404)
      expect(await response.text()).not.toContain("m_w2")
    }
  })

  it("requires meeting:read", async () => {
    setRouteCtx(undefined)
    expect((await askRoute(askRequest({ question: "q", scope: { kind: "workspace" } }), routeParams({}))).status).toBe(401)
  })
})

describe("thread routes", () => {
  it("caps active threads per user (409) and rate-limits thread creation (429)", async () => {
    process.env.MEETSUM_ASK_MAX_ACTIVE_THREADS = "3"
    setRouteCtx(await member())

    const create = () => createThread(jsonRequest("http://localhost/api/ask/threads", "POST", { scope: { kind: "workspace" } }), routeParams({}))

    try {
      for (let index = 0; index < 3; index += 1) expect((await create()).status).toBe(201)

      const blocked = await create()

      expect(blocked.status).toBe(409)
      expect(await blocked.json()).toEqual({ error: "thread_limit" })

      // Another user has their own cap.
      setRouteCtx(await member("user_other"))
      expect((await create()).status).toBe(201)
    } finally {
      delete process.env.MEETSUM_ASK_MAX_ACTIVE_THREADS
    }

    setRouteCtx(await member("user_burst"))
    const statuses: number[] = []

    for (let index = 0; index < 35; index += 1) statuses.push((await create()).status)
    expect(statuses.filter((status) => status === 201)).toHaveLength(30)
    expect(statuses.at(-1)).toBe(429)
  })

  it("lists, reads, renames, archives, deletes (audited, ids only) and rates the caller's threads", async () => {
    const ctx = await member()

    setRouteCtx(ctx)
    await (await askRoute(askRequest({ question: "שאלה סודית?", scope: { kind: "workspace" } }, "application/json"), routeParams({}))).json()

    const list = await (await listThreads(new Request("http://localhost/api/ask/threads?scope=workspace"), routeParams({}))).json()

    expect(list.threads).toHaveLength(1)

    const id = list.threads[0].id as string
    const detail = await (await getThread(new Request(`http://localhost/api/ask/threads/${id}`), routeParams({ id }))).json()

    expect(detail.messages.map((message: { role: string }) => message.role)).toEqual(["user", "assistant"])
    expect(detail.messages[1].citations[0].meetingId).toBe("m1")

    const renamed = await patchThread(jsonRequest(`http://localhost/api/ask/threads/${id}`, "PATCH", { title: "חדש", archived: true }), routeParams({ id }))

    expect((await renamed.json()).thread).toMatchObject({ title: "חדש", archived: true })

    const feedback = await feedbackRoute(
      jsonRequest(`http://localhost/api/ask/messages/${detail.messages[1].id}/feedback`, "POST", { rating: -1 }),
      routeParams({ id: detail.messages[1].id })
    )

    expect(feedback.status).toBe(200)
    expect((await deleteThread(new Request("http://localhost", { method: "DELETE" }), routeParams({ id }))).status).toBe(200)
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "ask.thread.deleted", targetId: id, workspaceId: "ws_a" }))
    expect(JSON.stringify(recordAuditLog.mock.calls)).not.toContain("שאלה סודית")
    expect((await getThread(new Request("http://localhost"), routeParams({ id }))).status).toBe(404)
  })

  it("answers 404 for another user's thread and message, even for an admin", async () => {
    setRouteCtx(await member("user_a"))
    await askRoute(askRequest({ question: "q?", scope: { kind: "workspace" } }, "application/json"), routeParams({}))

    const list = await (await listThreads(new Request("http://localhost/api/ask/threads"), routeParams({}))).json()
    const id = list.threads[0].id as string
    const detail = await (await getThread(new Request("http://localhost"), routeParams({ id }))).json()
    const messageId = detail.messages[1].id as string

    setRouteCtx(await createTestCtx({ database, userId: "user_b", email: "b@example.com", role: "admin" }))
    expect((await getThread(new Request("http://localhost"), routeParams({ id }))).status).toBe(404)
    expect((await patchThread(jsonRequest("http://localhost", "PATCH", { title: "x" }), routeParams({ id }))).status).toBe(404)
    expect((await deleteThread(new Request("http://localhost", { method: "DELETE" }), routeParams({ id }))).status).toBe(404)
    expect((await feedbackRoute(jsonRequest("http://localhost", "POST", { rating: 1 }), routeParams({ id: messageId }))).status).toBe(404)
    expect((await (await listThreads(new Request("http://localhost/api/ask/threads"), routeParams({}))).json()).threads).toEqual([])
    expect(recordAuditLog).not.toHaveBeenCalled()
  })

  it("forbids API keys on every thread route", async () => {
    setRouteCtx(await createTestCtx({ database, principal: "api_key" }))

    const responses = [
      await listThreads(new Request("http://localhost/api/ask/threads"), routeParams({})),
      await createThread(jsonRequest("http://localhost/api/ask/threads", "POST", { scope: { kind: "workspace" } }), routeParams({})),
      await getThread(new Request("http://localhost"), routeParams({ id: "thr_1" })),
      await patchThread(jsonRequest("http://localhost", "PATCH", { title: "x" }), routeParams({ id: "thr_1" })),
      await deleteThread(new Request("http://localhost", { method: "DELETE" }), routeParams({ id: "thr_1" })),
      await feedbackRoute(jsonRequest("http://localhost", "POST", { rating: 1 }), routeParams({ id: "msg_1" })),
    ]

    for (const response of responses) expect(response.status).toBe(403)
  })

  it("creates threads only on visible scopes and rejects a bad cursor", async () => {
    setRouteCtx(await member())

    expect((await createThread(jsonRequest("http://localhost", "POST", { scope: { kind: "meeting", meetingId: "m_private" } }), routeParams({}))).status).toBe(404)
    expect((await createThread(jsonRequest("http://localhost", "POST", { scope: { kind: "meeting", meetingId: "m1" } }), routeParams({}))).status).toBe(201)
    expect((await listThreads(new Request("http://localhost/api/ask/threads?cursor=bogus"), routeParams({}))).status).toBe(400)
    expect((await feedbackRoute(jsonRequest("http://localhost", "POST", { rating: 5 }), routeParams({ id: "msg_1" }))).status).toBe(400)
  })
})

describe("compat routes", () => {
  it("keeps the legacy meeting ask shape", async () => {
    setRouteCtx(await member())

    const body = await (await meetingAsk(jsonRequest("http://localhost", "POST", { question: "מה הוחלט?" }), routeParams({ id: "m1" }))).json()

    expect(body.answer).toEqual({ answer: "התקציב אושר [s1].", citations: [{ meetingId: "m1", segmentId: "seg_q", startMs: 42_000 }] })
    expect((await meetingAsk(jsonRequest("http://localhost", "POST", { question: "q" }), routeParams({ id: "m_private" }))).status).toBe(404)
    expect((await meetingAsk(jsonRequest("http://localhost", "POST", {}), routeParams({ id: "m1" }))).status).toBe(400)
  })

  it("keeps the legacy room and memory shapes", async () => {
    setRouteCtx(await member())

    const room = await (await roomAsk(jsonRequest("http://localhost", "POST", { question: "מה הוחלט?" }), routeParams({ id: ROOM.id }))).json()

    expect(room).toMatchObject({ answer: "התקציב אושר [s1]." })
    expect(room.citations).toEqual([
      { meetingId: "m1", meetingTitle: "סקירת תקציב", source: "transcript", text: "התקציב אושר", segmentId: "seg_q", startMs: 42_000 },
    ])
    expect((await roomAsk(jsonRequest("http://localhost", "POST", { question: "q" }), routeParams({ id: "ctx_other" }))).status).toBe(404)

    const memory = await (await memoryAsk(jsonRequest("http://localhost", "POST", { question: "מה הוחלט?" }), routeParams({}))).json()

    expect(memory.citations[0]).toMatchObject({ source: "transcript", meetingId: "m1" })
  })

  it("does not persist compat questions as threads", async () => {
    setRouteCtx(await member())
    await memoryAsk(jsonRequest("http://localhost", "POST", { question: "q?" }), routeParams({}))

    expect((await (await listThreads(new Request("http://localhost/api/ask/threads"), routeParams({}))).json()).threads).toEqual([])
  })
})
