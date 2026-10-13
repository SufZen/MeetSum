import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { LlmError, type LlmStreamEvent, type LlmStreamRequest } from "@/lib/ai/llm/types"
import { askOnce, askStream, resetAskCountersForTesting, setAskDepsForTesting } from "@/lib/ask/service"
import { createThreadStore, resetMemoryThreadStoreForTesting } from "@/lib/ask/thread-store"
import type { AskStreamEvent } from "@/lib/ask/types"
import type { AuthContext } from "@/lib/auth/authz"
import { createInMemoryMeetingDatabase, type InMemoryMeetingDatabase } from "@/lib/meetings/repository"
import { setRateLimitStoreForTesting } from "@/lib/rate-limit"
import type { MeetingChunk, RetrievedPassage, RetrieveRequest, RetrieveResult, SearchContext } from "@/lib/search/types"

import { createTestCtx, testMeeting } from "./helpers/route-ctx"

/**
 * AskMeetSum service (docs/parity/m6.md, C7 tests) with a fake retriever
 * (Package B's `retrievePassages` is not touched) and a fake LLM stream.
 */

const SECRET_TEXT = "הסכום הסודי הוא 4,200,000 ש״ח"
const QUESTION = "מה הוחלט על התקציב?"

const ROOM = { id: "ctx_room", name: "Board", createdAt: "2026-10-01T00:00:00Z" }

function seed(): InMemoryMeetingDatabase {
  const big = Array.from({ length: 5 }, (_, index) => ({
    id: `seg_big_${index}`,
    speaker: "דנה",
    startMs: index * 1000,
    endMs: index * 1000 + 900,
    text: "מילה ".repeat(50),
  }))
  const db = createInMemoryMeetingDatabase([
    testMeeting({ id: "m_w1", title: "סקירת תקציב", contexts: [ROOM], transcript: big }),
    testMeeting({ id: "m_w1_other", title: "גיוס", transcript: big }),
    testMeeting({
      id: "m_private",
      title: "פגישה פרטית",
      visibility: "private",
      ownerUserId: "user_owner",
      contexts: [ROOM],
      transcript: big,
    }),
    testMeeting({ id: "m_w2", title: "W2 budget", workspaceId: "ws_b", transcript: big }),
    testMeeting({
      id: "m_small",
      title: "קצרה",
      transcript: [{ id: "seg_s1", speaker: "דנה", startMs: 0, endMs: 1000, text: "התקציב אושר" }],
    }),
  ])

  db.contexts.set(ROOM.id, ROOM)
  db.contextWorkspaces.set(ROOM.id, "ws_a")
  return db
}

function chunk(meetingId: string, workspaceId = "ws_a"): MeetingChunk {
  return {
    id: `chunk_${meetingId}`,
    workspaceId,
    meetingId,
    transcriptVersion: 1,
    kind: "transcript",
    chunkIndex: 0,
    segmentIds: [`seg_${meetingId}`],
    segmentStartMs: [61_000],
    segmentOffsets: [5],
    overlapCount: 0,
    speakerIds: ["sp1"],
    startMs: 61_000,
    text: `דנה: ${SECRET_TEXT}`,
    textNorm: "",
    textStem: "",
    tokenEstimate: 20,
    contentHash: "h",
  }
}

function passage(meetingId: string, workspaceId = "ws_a"): RetrievedPassage {
  return {
    chunk: chunk(meetingId, workspaceId),
    meetingTitle: `title ${meetingId}`,
    meetingStartedAt: "2026-10-01T10:00:00.000Z",
    speakerNames: { sp1: "דנה" },
    segmentTexts: { [`seg_${meetingId}`]: SECRET_TEXT },
    score: 0.9,
  }
}

type FakeRetrieve = (ctx: SearchContext, req: RetrieveRequest) => Promise<RetrieveResult>

function retrieving(passages: RetrievedPassage[], extra: Partial<RetrieveResult> = {}): ReturnType<typeof vi.fn<FakeRetrieve>> {
  return vi.fn<FakeRetrieve>(async () => ({ passages, mode: "hybrid", topSimilarity: 0.8, lexicalHits: 2, ...extra }))
}

function streaming(deltas: string[], options: { failAfter?: Error; abort?: AbortController } = {}) {
  return vi.fn(async function* (req: LlmStreamRequest): AsyncGenerator<LlmStreamEvent> {
    void req
    yield { type: "start", provider: "gemini", model: "gemini-3.8-flash" }

    let text = ""

    for (const [index, delta] of deltas.entries()) {
      text += delta
      yield { type: "delta", text: delta }
      if (index === 0 && options.abort) options.abort.abort()
    }
    if (options.failAfter) throw options.failAfter
    yield {
      type: "done",
      provider: "gemini",
      model: "gemini-3.8-flash",
      text,
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 0 },
      costUsd: 0.001,
      latencyMs: 5,
      aiRunId: "airun_1",
      attempts: [],
    }
  })
}

async function collect(stream: AsyncIterable<AskStreamEvent>) {
  const events: AskStreamEvent[] = []

  for await (const event of stream) events.push(event)
  return events
}

const doneOf = (events: AskStreamEvent[]) => events.find((event) => event.type === "done") as Extract<AskStreamEvent, { type: "done" }>
const contextOf = (events: AskStreamEvent[]) =>
  events.find((event) => event.type === "context") as Extract<AskStreamEvent, { type: "context" }>

let database: InMemoryMeetingDatabase
let logSpies: Array<ReturnType<typeof vi.spyOn>>

async function member(userId = "user_me", workspaceId = "ws_a"): Promise<AuthContext> {
  return createTestCtx({ database, userId, email: `${userId}@example.com`, workspaceId, role: "member" })
}

beforeEach(() => {
  database = seed()
  resetMemoryThreadStoreForTesting()
  resetAskCountersForTesting()
  setRateLimitStoreForTesting(new Map())
  delete process.env.MEETSUM_RATE_LIMIT
  delete process.env.MEETSUM_STORAGE
  delete process.env.MEETSUM_ASK_DAILY_LIMIT_PER_USER
  delete process.env.MEETSUM_ASK_FULL_TRANSCRIPT_TOKENS
  logSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {})
  )
})

afterEach(() => {
  setAskDepsForTesting(undefined)
  setRateLimitStoreForTesting(undefined)
  for (const spy of logSpies) spy.mockRestore()
})

function expectNoTranscriptInLogs() {
  const logged = JSON.stringify(logSpies.map((spy) => spy.mock.calls))

  expect(logged).not.toContain(SECRET_TEXT)
  expect(logged).not.toContain(QUESTION)
}

describe("askStream", () => {
  it("streams a complete, cited answer and persists the thread", async () => {
    const retrieve = retrieving([passage("m_w1")])
    const stream = streaming(["התקציב אושר [s", "1]. ", "ההנהלה מרוצה מאוד מהתוצאות של השנה הזאת בכל המדדים."])

    setAskDepsForTesting({ retrieve, stream, settings: async () => ({}) })

    const ctx = await member()
    const events = await collect(askStream(ctx, { question: QUESTION, scope: { kind: "workspace" } }))

    expect(events.map((event) => event.type)).toEqual(["thread", "context", "delta", "delta", "delta", "done"])
    expect(events.filter((event) => event.type === "delta").map((event) => (event as { text: string }).text).join("")).toBe(
      "התקציב אושר [s1]. ההנהלה מרוצה מאוד מהתוצאות של השנה הזאת בכל המדדים."
    )

    const done = doneOf(events)

    expect(done).toMatchObject({ status: "complete", content: "התקציב אושר [s1].", grounded: true, language: "he", droppedUncitedSentences: 1 })
    expect(done.citations).toEqual([
      expect.objectContaining({ n: 1, alias: "s1", meetingId: "m_w1", segmentId: "seg_m_w1", startMs: 61_000, quote: SECRET_TEXT }),
    ])
    expect(done.usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 50 })

    const thread = events[0] as Extract<AskStreamEvent, { type: "thread" }>
    const stored = await createThreadStore(ctx)!.getThread(thread.threadId!)

    expect(stored?.thread.title).toBe(QUESTION)
    expect(stored?.messages.map((message) => [message.role, message.status, message.content])).toEqual([
      ["user", "complete", QUESTION],
      ["assistant", "complete", "התקציב אושר [s1]."],
    ])
    expect(retrieve.mock.calls[0][0]).toMatchObject({ workspaceId: "ws_a", scope: { kind: "member", userId: "user_me" } })

    const llm = stream.mock.calls[0][0]

    expect(llm).toMatchObject({ task: "chat", ctx: { workspaceId: "ws_a", promptVersion: "m6.ask.1" }, maxOutputTokens: 1500 })
    expect(llm).not.toHaveProperty("tools")
    expect(JSON.stringify(llm.runMetadata)).not.toContain(SECRET_TEXT)
  })

  it("refuses without an LLM call when nothing relevant is retrieved", async () => {
    const stream = streaming(["x"])

    setAskDepsForTesting({ retrieve: retrieving([]), stream, settings: async () => ({}) })

    const events = await collect(askStream(await member(), { question: "What is the weather in Paris?", scope: { kind: "workspace" } }))
    const done = doneOf(events)

    expect(done).toMatchObject({ status: "refused", content: "I couldn't find this in your meetings.", citations: [], grounded: false, language: "en" })
    expect(stream).not.toHaveBeenCalled()
  })

  it("refuses a weak vector match without lexical hits, and never calls the LLM", async () => {
    const stream = streaming(["x"])

    setAskDepsForTesting({ retrieve: retrieving([passage("m_w1")], { topSimilarity: 0.3, lexicalHits: 0 }), stream, settings: async () => ({}) })

    expect(doneOf(await collect(askStream(await member(), { question: QUESTION, scope: { kind: "workspace" } }))).status).toBe("refused")
    expect(stream).not.toHaveBeenCalled()
  })

  it("swallows the model sentinel and refuses", async () => {
    setAskDepsForTesting({ retrieve: retrieving([passage("m_w1")]), stream: streaming(["<<NO_", "ANSWER>>"]), settings: async () => ({}) })

    const events = await collect(askStream(await member(), { question: QUESTION, scope: { kind: "workspace" } }))

    expect(events.some((event) => event.type === "delta")).toBe(false)
    expect(doneOf(events)).toMatchObject({ status: "refused", content: "לא מצאתי בפגישות מידע שעונה על השאלה." })
  })

  it("refuses when every sentence is uncited (no citation, no claim)", async () => {
    setAskDepsForTesting({
      retrieve: retrieving([passage("m_w1")]),
      stream: streaming(["התקציב הוא 5 מיליון. הגיוס נדחה [s404]."]),
      settings: async () => ({}),
    })

    const done = doneOf(await collect(askStream(await member(), { question: QUESTION, scope: { kind: "workspace" } })))

    expect(done).toMatchObject({ status: "refused", grounded: false, citations: [], droppedUncitedSentences: 2 })
  })

  it("saves an aborted answer with its partial content when the client disconnects", async () => {
    const controller = new AbortController()

    setAskDepsForTesting({
      retrieve: retrieving([passage("m_w1")]),
      stream: streaming(["התקציב אושר [s1]", " ועוד", " ועוד"], { abort: controller }),
      settings: async () => ({}),
    })

    const ctx = await member()
    const events = await collect(askStream(ctx, { question: QUESTION, scope: { kind: "workspace" } }, controller.signal))

    expect(events.some((event) => event.type === "done")).toBe(false)

    const threadId = (events[0] as Extract<AskStreamEvent, { type: "thread" }>).threadId!
    const stored = await createThreadStore(ctx)!.getThread(threadId)

    expect(stored?.messages[1]).toMatchObject({ role: "assistant", status: "aborted", content: "התקציב אושר [s1]" })
  })

  it("passes the abort signal to the LLM stream", async () => {
    const controller = new AbortController()
    const stream = streaming(["התקציב אושר [s1]."])

    setAskDepsForTesting({ retrieve: retrieving([passage("m_w1")]), stream, settings: async () => ({}) })
    await collect(askStream(await member(), { question: QUESTION, scope: { kind: "workspace" } }, controller.signal))

    expect(stream.mock.calls[0][0].signal).toBe(controller.signal)
  })

  it("turns an LLM failure after a delta into an error event without leaking text to logs", async () => {
    setAskDepsForTesting({
      retrieve: retrieving([passage("m_w1")]),
      stream: streaming(["התקציב"], { failAfter: new LlmError(`boom ${SECRET_TEXT}`, "server", "gemini", true) }),
      settings: async () => ({}),
    })

    const ctx = await member()
    const events = await collect(askStream(ctx, { question: QUESTION, scope: { kind: "workspace" } }))

    expect(events.at(-1)).toEqual({ type: "error", code: "llm_unavailable", message: "שירות התשובות אינו זמין כרגע. אפשר לנסות שוב מאוחר יותר." })

    const threadId = (events[0] as Extract<AskStreamEvent, { type: "thread" }>).threadId!

    expect((await createThreadStore(ctx)!.getThread(threadId))?.messages[1].status).toBe("error")
    expectNoTranscriptInLogs()
  })

  it("uses the full transcript for a short meeting without retrieval", async () => {
    const retrieve = retrieving([])
    const stream = streaming(["התקציב אושר [s1]."])

    setAskDepsForTesting({ retrieve, stream, settings: async () => ({}) })

    const events = await collect(askStream(await member(), { question: QUESTION, scope: { kind: "meeting", meetingId: "m_small" } }))

    expect(contextOf(events).mode).toBe("full_transcript")
    expect(retrieve).not.toHaveBeenCalled()
    expect(doneOf(events)).toMatchObject({ status: "complete", citations: [expect.objectContaining({ segmentId: "seg_s1" })] })
    expect(stream.mock.calls[0][0].ctx.meetingId).toBe("m_small")
  })

  it("passes the workspace provider preference to the stream", async () => {
    const stream = streaming(["התקציב אושר [s1]."])

    setAskDepsForTesting({ retrieve: retrieving([passage("m_w1")]), stream, settings: async () => ({ llmProviderPreference: "anthropic" }) })
    await collect(askStream(await member(), { question: QUESTION, scope: { kind: "workspace" } }))

    expect(stream.mock.calls[0][0].preference).toBe("anthropic")
  })
})

describe("askStream scopes and isolation", () => {
  it("never cites another workspace's meeting (W1/W2) or a private meeting the caller can't see", async () => {
    const stream = streaming(["תשובה [s1]."])

    setAskDepsForTesting({
      retrieve: retrieving([passage("m_w2", "ws_b"), passage("m_w2", "ws_a"), passage("m_private")]),
      stream,
      settings: async () => ({}),
    })

    const events = await collect(askStream(await member(), { question: QUESTION, scope: { kind: "workspace" } }))
    const serialized = JSON.stringify(events)

    expect(serialized).not.toContain("m_w2")
    expect(serialized).not.toContain("m_private")
    expect(Object.keys(contextOf(events).aliases)).toEqual([])
    expect(doneOf(events).status).toBe("refused")
    expect(stream).not.toHaveBeenCalled()
  })

  it("keeps an invisible meeting out of a room the viewer can see", async () => {
    const stream = streaming(["תשובה [s1]."])

    setAskDepsForTesting({
      retrieve: retrieving([passage("m_private"), passage("m_w1"), passage("m_w1_other")]),
      stream,
      settings: async () => ({}),
    })

    const viewer = await createTestCtx({ database, userId: "user_viewer", email: "viewer@example.com", role: "viewer" })
    const events = await collect(askStream(viewer, { question: QUESTION, scope: { kind: "room", roomId: ROOM.id } }))
    const aliases = Object.values(contextOf(events).aliases)

    expect(aliases.map((alias) => alias.meetingId)).toEqual(["m_w1"])
    expect(JSON.stringify(events)).not.toContain("m_private")
    expect(JSON.stringify(stream.mock.calls)).not.toContain("פגישה פרטית")
  })

  it("lets the private meeting's owner see it", async () => {
    setAskDepsForTesting({ retrieve: retrieving([passage("m_private")]), stream: streaming(["תשובה [s1]."]), settings: async () => ({}) })

    const owner = await member("user_owner")
    const done = doneOf(await collect(askStream(owner, { question: QUESTION, scope: { kind: "workspace" } })))

    expect(done.citations[0].meetingId).toBe("m_private")
  })

  it("answers not_found for an invisible or foreign meeting and a foreign room", async () => {
    setAskDepsForTesting({ retrieve: retrieving([]), stream: streaming([]), settings: async () => ({}) })

    const ctx = await member()

    for (const scope of [
      { kind: "meeting" as const, meetingId: "m_private" },
      { kind: "meeting" as const, meetingId: "m_w2" },
      { kind: "room" as const, roomId: "ctx_unknown" },
    ]) {
      const events = await collect(askStream(ctx, { question: QUESTION, scope }))

      expect(events).toEqual([{ type: "error", code: "not_found", message: "הפגישה או החדר לא נמצאו." }])
    }

    const w2 = await member("user_me", "ws_b")

    expect((await collect(askStream(w2, { question: QUESTION, scope: { kind: "room", roomId: ROOM.id } })))[0]).toMatchObject({
      code: "not_found",
    })
  })

  it("answers not_found for another user's thread", async () => {
    setAskDepsForTesting({ retrieve: retrieving([passage("m_w1")]), stream: streaming(["תשובה [s1]."]), settings: async () => ({}) })

    const first = await collect(askStream(await member("user_a"), { question: QUESTION, scope: { kind: "workspace" } }))
    const threadId = (first[0] as Extract<AskStreamEvent, { type: "thread" }>).threadId!
    const events = await collect(askStream(await member("user_b"), { question: QUESTION, scope: { kind: "workspace" }, threadId }))

    expect(events).toEqual([{ type: "error", code: "not_found", message: "הפגישה או החדר לא נמצאו." }])
  })

  it("continues a thread with history and the previous question for retrieval", async () => {
    const retrieve = retrieving([passage("m_w1")])
    const stream = streaming(["תשובה [s1]."])

    setAskDepsForTesting({ retrieve, stream, settings: async () => ({}) })

    const ctx = await member()
    const first = await collect(askStream(ctx, { question: "שאלה ראשונה?", scope: { kind: "workspace" } }))
    const threadId = (first[0] as Extract<AskStreamEvent, { type: "thread" }>).threadId!

    await collect(askStream(ctx, { question: "ומה עוד?", scope: { kind: "workspace" }, threadId }))

    expect(retrieve.mock.calls[1][1]).toMatchObject({ question: "ומה עוד?", previousQuestion: "שאלה ראשונה?" })
    expect(stream.mock.calls[1][0].messages.map((message) => message.role)).toEqual(["user", "assistant", "user"])
  })
})

describe("API keys and limits", () => {
  it("keeps API-key principals stateless", async () => {
    setAskDepsForTesting({ retrieve: retrieving([passage("m_w1")]), stream: streaming(["תשובה [s1]."]), settings: async () => ({}) })

    const key = await createTestCtx({ database, principal: "api_key", role: "member" })
    const events = await collect(askStream(key, { question: QUESTION, scope: { kind: "workspace" } }))

    expect(events[0]).toEqual({ type: "thread", threadId: null, userMessageId: null, assistantMessageId: null })
    expect(doneOf(events).status).toBe("complete")
  })

  it("enforces the daily cap per user and per API key", async () => {
    process.env.MEETSUM_ASK_DAILY_LIMIT_PER_USER = "2"
    setAskDepsForTesting({ retrieve: retrieving([passage("m_w1")]), stream: streaming(["תשובה [s1]."]), settings: async () => ({}) })

    const ctx = await member()

    await collect(askStream(ctx, { question: QUESTION, scope: { kind: "workspace" } }))
    await collect(askStream(ctx, { question: QUESTION, scope: { kind: "workspace" }, persist: false }))
    expect((await collect(askStream(ctx, { question: QUESTION, scope: { kind: "workspace" } })))[0]).toMatchObject({ code: "daily_limit" })

    const key = await createTestCtx({ database, principal: "api_key", role: "member" })

    await collect(askStream(key, { question: QUESTION, scope: { kind: "workspace" } }))
    await collect(askStream(key, { question: QUESTION, scope: { kind: "workspace" } }))
    expect((await collect(askStream(key, { question: QUESTION, scope: { kind: "workspace" } })))[0]).toMatchObject({ code: "daily_limit" })
  })
})

describe("askOnce", () => {
  it("aggregates the stream for JSON mode", async () => {
    setAskDepsForTesting({ retrieve: retrieving([passage("m_w1")]), stream: streaming(["Approved [s1]."]), settings: async () => ({}) })

    const result = await askOnce(await member(), { question: "What was approved?", scope: { kind: "workspace" } })

    expect(result).toMatchObject({ status: "complete", content: "Approved [s1].", grounded: true, language: "en" })
    expect(result.threadId).toMatch(/^thr_/)
    expect(result.citations).toHaveLength(1)
  })

  it("reports errors with their code", async () => {
    setAskDepsForTesting({ retrieve: retrieving([]), stream: streaming([]), settings: async () => ({}) })

    const result = await askOnce(await member(), { question: QUESTION, scope: { kind: "meeting", meetingId: "nope" } })

    expect(result).toMatchObject({ status: "error", error: { code: "not_found" } })
  })
})

describe("logs", () => {
  it("never logs the question or transcript text, even on unexpected failures", async () => {
    setAskDepsForTesting({
      retrieve: vi.fn(async () => {
        throw new Error(`db failed near '${SECRET_TEXT}' for ${QUESTION}`)
      }),
      stream: streaming([]),
      settings: async () => ({}),
    })

    const events = await collect(askStream(await member(), { question: QUESTION, scope: { kind: "workspace" } }))

    expect(events.at(-1)).toMatchObject({ type: "error", code: "internal" })
    expect(JSON.stringify(events)).not.toContain(SECRET_TEXT)
    expectNoTranscriptInLogs()
  })
})

