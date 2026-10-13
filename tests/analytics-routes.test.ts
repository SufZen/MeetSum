import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createTestCtx, jsonRequest, routeParams, setRouteCtx, testMeeting } from "./helpers/route-ctx"

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authz")>()
  const { mockAuthzModule } = await import("./helpers/route-ctx")

  return mockAuthzModule(actual)
})

const generateStructured = vi.hoisted(() => vi.fn())

vi.mock("@/lib/ai/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/llm")>()

  return { ...actual, generateStructured }
})

import { GET } from "@/app/api/meetings/[id]/analytics/route"
import { POST as rerunSentiment } from "@/app/api/meetings/[id]/analytics/sentiment/route"
import { resetMemoryAnalytics } from "@/lib/analytics/store"
import {
  createInMemoryMeetingDatabase,
  type InMemoryMeetingDatabase,
  type TranscriptSegment,
} from "@/lib/meetings/repository"
import type { WorkspaceRole } from "@/lib/workspaces/types"

const BASE = "http://localhost/api/meetings"

const transcript: TranscriptSegment[] = [
  { id: "s1", speaker: "Speaker 1", speakerId: "spk_1", startMs: 0, endMs: 10_000, text: "שלום, מה הסטטוס?" },
  { id: "s2", speaker: "Speaker 2", speakerId: "spk_2", startMs: 10_100, endMs: 30_000, text: "הכל מוכן כאילו" },
]

let database: InMemoryMeetingDatabase

async function as(role: WorkspaceRole, workspaceId = "ws_a") {
  setRouteCtx(await createTestCtx({ role, workspaceId, database }))
}

const get = (id: string) => GET(new Request(`${BASE}/${id}/analytics`), routeParams({ id }))
const post = (id: string, body?: unknown) =>
  rerunSentiment(jsonRequest(`${BASE}/${id}/analytics/sentiment`, "POST", body), routeParams({ id }))

beforeEach(() => {
  resetMemoryAnalytics()
  database = createInMemoryMeetingDatabase([
    testMeeting({ id: "m_a", workspaceId: "ws_a", transcript }),
    testMeeting({ id: "m_private", workspaceId: "ws_a", visibility: "private", ownerUserId: "someone_else", transcript }),
    testMeeting({ id: "m_b", workspaceId: "ws_b", transcript }),
  ])
  generateStructured.mockReset()
  generateStructured.mockResolvedValue({
    value: {
      turns: [
        { turn: "t1", label: "neutral", score: 0 },
        { turn: "t2", label: "positive", score: 0.7 },
      ],
    },
    provider: "anthropic",
    model: "claude-haiku-5-5",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    costUsd: 0,
    latencyMs: 1,
    attempts: [],
    fallbackUsed: false,
    aiRunId: "run_s",
  })
})

afterEach(() => {
  delete process.env.MEETSUM_SENTIMENT_ENABLED
})

describe("GET /api/meetings/:id/analytics", () => {
  it("computes and stores metrics for a viewer, then serves the stored row", async () => {
    await as("viewer")

    const first = await get("m_a")
    const body = await first.json()

    expect(first.status).toBe(200)
    expect(body.recomputed).toBe(true)
    expect(body.sentimentEnabled).toBe(true)
    expect(body.analytics.metrics.basis).toBe("text")
    expect(body.analytics.metrics.speakers.map((s: { questions: number }) => s.questions)).toEqual([1, 0])
    expect(body.analytics.metrics.interruptions).toBe(1)

    const second = await (await get("m_a")).json()

    expect(second.recomputed).toBe(false)
    expect(second.analytics.transcriptHash).toBe(body.analytics.transcriptHash)
  })

  it("answers 404 for an invisible or foreign meeting", async () => {
    await as("owner")

    expect((await get("m_private")).status).toBe(404)
    expect((await get("m_b")).status).toBe(404)
    expect((await get("missing")).status).toBe(404)
  })

  it("answers 401 without a session", async () => {
    setRouteCtx(undefined)

    expect((await get("m_a")).status).toBe(401)
  })
})

describe("POST /api/meetings/:id/analytics/sentiment", () => {
  it("is forbidden to viewers", async () => {
    await as("viewer")

    expect((await post("m_a")).status).toBe(403)
    expect(generateStructured).not.toHaveBeenCalled()
  })

  it("re-runs sentiment and stores it with the metrics", async () => {
    await as("member")

    const response = await post("m_a", {})
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.sentiment).toBe("ok")
    expect(body.analytics.sentiment.bySpeaker.map((s: { label: string }) => s.label)).toEqual(["neutral", "positive"])
    expect(body.analytics.sentimentAiRunId).toBe("run_s")
    expect(generateStructured).toHaveBeenCalledWith(
      expect.objectContaining({ task: "sentiment", signal: expect.any(AbortSignal), maxRetries: 1 })
    )

    const read = await (await get("m_a")).json()

    expect(read.analytics.sentiment.overall.turns).toBe(2)
  })

  it("keeps metrics and answers 502 when sentiment fails", async () => {
    await as("member")
    generateStructured.mockRejectedValue(new Error("provider down"))

    const response = await post("m_a")
    const body = await response.json()

    expect(response.status).toBe(502)
    expect(body.sentiment).toBe("failed")
    expect(body.analytics.metrics.speakers).toHaveLength(2)
  })

  it("answers 409 when sentiment is disabled and 404 for invisible meetings", async () => {
    await as("member")

    expect((await post("m_b")).status).toBe(404)
    process.env.MEETSUM_SENTIMENT_ENABLED = "false"
    expect((await post("m_a")).status).toBe(409)
  })

  it("validates force", async () => {
    await as("member")

    expect((await post("m_a", { force: "yes" })).status).toBe(400)
  })
})
