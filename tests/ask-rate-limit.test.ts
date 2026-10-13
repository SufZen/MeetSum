import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The `ask` rate limit (security review follow-up): one bucket per
 * `${workspaceId}:${userId|apiKeyCreatorId}`, enforced inside the service
 * for every entry point (SSE, JSON/askOnce, compat routes, follow-ups),
 * never keyed on headers, thread ids, scope or question text, and failing
 * closed when the limiter store errors.
 */

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authz")>()
  const { mockAuthzModule } = await import("./helpers/route-ctx")

  return mockAuthzModule(actual)
})

import { POST as askRoute } from "@/app/api/ask/route"
import { POST as meetingAsk } from "@/app/api/meetings/[id]/ask/route"
import { POST as memoryAsk } from "@/app/api/memory/ask/route"
import { POST as roomAsk } from "@/app/api/rooms/[id]/ask/route"
import type { LlmStreamEvent } from "@/lib/ai/llm/types"
import { askOnce, askRateLimitKey, askStream, resetAskCountersForTesting, setAskDepsForTesting } from "@/lib/ask/service"
import { resetMemoryThreadStoreForTesting } from "@/lib/ask/thread-store"
import type { AskRequest, AskStreamEvent } from "@/lib/ask/types"
import type { AuthContext } from "@/lib/auth/authz"
import { createInMemoryMeetingDatabase, type InMemoryMeetingDatabase } from "@/lib/meetings/repository"
import { RATE_LIMIT_PRESETS, setRateLimitStoreForTesting, type RateLimitStore } from "@/lib/rate-limit"

import { createTestCtx, routeParams, setRouteCtx, testMeeting } from "./helpers/route-ctx"

const LIMIT = RATE_LIMIT_PRESETS.ask.maxRequests
const ROOM = { id: "ctx_room", name: "Board", createdAt: "2026-10-01T00:00:00Z" }

let database: InMemoryMeetingDatabase

async function* answer(): AsyncGenerator<LlmStreamEvent> {
  yield { type: "delta", text: "תשובה [s1]." }
  yield {
    type: "done",
    provider: "gemini",
    model: "gemini-3.8-flash",
    text: "תשובה [s1].",
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    costUsd: 0,
    latencyMs: 1,
    attempts: [],
  }
}

async function events(ctx: AuthContext, req: AskRequest): Promise<AskStreamEvent[]> {
  const out: AskStreamEvent[] = []

  for await (const event of askStream(ctx, req)) out.push(event)
  return out
}

const isRateLimited = (list: AskStreamEvent[]) => list.some((event) => event.type === "error" && event.code === "rate_limited")

async function user(userId = "user_me", workspaceId = "ws_a") {
  return createTestCtx({ database, userId, email: `${userId}@example.com`, workspaceId, role: "member" })
}

beforeEach(() => {
  database = createInMemoryMeetingDatabase([
    testMeeting({ id: "m1", contexts: [ROOM], transcript: [{ id: "seg_1", speaker: "דנה", startMs: 0, endMs: 1, text: "התקציב אושר" }] }),
  ])
  database.contexts.set(ROOM.id, ROOM)
  database.contextWorkspaces.set(ROOM.id, "ws_a")
  setRateLimitStoreForTesting(new Map())
  resetAskCountersForTesting()
  resetMemoryThreadStoreForTesting()
  delete process.env.MEETSUM_RATE_LIMIT
  delete process.env.MEETSUM_STORAGE
  setAskDepsForTesting({
    retrieve: async () => ({ passages: [], mode: "empty", topSimilarity: null, lexicalHits: 0 }),
    stream: answer,
    settings: async () => ({}),
  })
})

afterEach(() => {
  setAskDepsForTesting(undefined)
  setRateLimitStoreForTesting(undefined)
  setRouteCtx(undefined)
})

describe("askRateLimitKey", () => {
  it("keys on workspace and user / API-key creator only", async () => {
    expect(askRateLimitKey(await user())).toBe("ask:ws_a:user:user_me")

    const key = await createTestCtx({ database, principal: "api_key", apiKeyCreatedBy: "user_me" })

    expect(askRateLimitKey(key)).toBe("ask:ws_a:user:user_me")
  })
})

describe("one shared ask bucket, enforced in the service", () => {
  it("blocks the stream after the limit regardless of question, scope, thread or persist", async () => {
    const ctx = await user()
    const variants: AskRequest[] = [
      { question: "שאלה א", scope: { kind: "workspace" } },
      { question: "שאלה ב", scope: { kind: "meeting", meetingId: "m1" } },
      { question: "q", scope: { kind: "room", roomId: ROOM.id }, persist: false },
      { question: "שאלה ג", scope: { kind: "workspace" }, threadId: "thr_whatever" },
    ]

    for (let index = 0; index < LIMIT; index += 1) {
      expect(isRateLimited(await events(ctx, variants[index % variants.length]))).toBe(false)
    }
    for (const variant of variants) expect(isRateLimited(await events(ctx, variant))).toBe(true)
  })

  it("shares the bucket between askStream, askOnce and follow-ups", async () => {
    const ctx = await user()
    const first = await events(ctx, { question: "first", scope: { kind: "workspace" } })
    const threadId = (first[0] as Extract<AskStreamEvent, { type: "thread" }>).threadId!

    for (let index = 1; index < LIMIT; index += 1) {
      if (index % 2) await askOnce(ctx, { question: `q${index}`, scope: { kind: "workspace" } })
      else await events(ctx, { question: `q${index}`, scope: { kind: "workspace" }, threadId })
    }

    const blocked = await askOnce(ctx, { question: "one more", scope: { kind: "workspace" } })

    expect(blocked.error?.code).toBe("rate_limited")
    expect(isRateLimited(await events(ctx, { question: "follow-up", scope: { kind: "workspace" }, threadId }))).toBe(true)
  })

  it("counts API keys against their creator (rotating keys doesn't reset it)", async () => {
    const ctx = await user()

    for (let index = 0; index < LIMIT; index += 1) await events(ctx, { question: `q${index}`, scope: { kind: "workspace" } })

    const keyA = await createTestCtx({ database, principal: "api_key", apiKeyCreatedBy: "user_me" })

    expect(isRateLimited(await events(keyA, { question: "q", scope: { kind: "workspace" } }))).toBe(true)

    const otherUser = await user("user_other")

    expect(isRateLimited(await events(otherUser, { question: "q", scope: { kind: "workspace" } }))).toBe(false)
  })

  it("fails closed when the limiter store errors", async () => {
    const broken = {
      get: () => {
        throw new Error("store down")
      },
      set: () => {
        throw new Error("store down")
      },
      delete: () => false,
      clear: () => {},
      [Symbol.iterator]: function* () {},
    } as unknown as RateLimitStore

    setRateLimitStoreForTesting(broken)

    const list = await events(await user(), { question: "q", scope: { kind: "workspace" } })

    expect(list).toEqual([expect.objectContaining({ type: "error", code: "rate_limited" })])
    expect((await askOnce(await user(), { question: "q", scope: { kind: "workspace" } })).error?.code).toBe("rate_limited")
  })
})

describe("routes share the principal bucket", () => {
  const xff = (ip: string, body: unknown, accept = "application/json") =>
    new Request("http://localhost/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json", accept, "x-forwarded-for": ip },
      body: JSON.stringify(body),
    })

  it("can't be reset by rotating X-Forwarded-For, and covers /api/ask plus the 3 compat routes", async () => {
    setRouteCtx(await user())

    let ip = 0
    const next = () => `10.0.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`
    const calls = [
      () => askRoute(xff(next(), { question: "q", scope: { kind: "workspace" } }), routeParams({})),
      () => meetingAsk(xff(next(), { question: "q" }), routeParams({ id: "m1" })),
      () => roomAsk(xff(next(), { question: "q" }), routeParams({ id: ROOM.id })),
      () => memoryAsk(xff(next(), { question: "q" }), routeParams({})),
    ]

    for (let index = 0; index < LIMIT; index += 1) {
      expect((await calls[index % calls.length]()).status).not.toBe(429)
    }
    for (const call of calls) expect((await call()).status).toBe(429)
  })

  it("SSE mode reports rate_limited as an error event", async () => {
    const ctx = await user()

    for (let index = 0; index < LIMIT; index += 1) await askOnce(ctx, { question: "q", scope: { kind: "workspace" } })
    setRouteCtx(ctx)

    const response = await askRoute(xff("10.9.9.9", { question: "q", scope: { kind: "workspace" } }, "text/event-stream"), routeParams({}))
    const text = await response.text()

    expect(text).toContain("event: error")
    expect(text).toContain('"code":"rate_limited"')
  })
})
