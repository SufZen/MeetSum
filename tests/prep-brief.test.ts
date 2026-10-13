import { beforeEach, describe, expect, it, vi } from "vitest"

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

import { GET, POST } from "@/app/api/meetings/[id]/prep/route"
import { LlmError, type LlmStructuredRequest } from "@/lib/ai/llm"
import { generatePrepBrief, getPrepBrief, type PrepBriefOutput } from "@/lib/intelligence/prep/brief"
import { resetMemoryGeneratedDocs } from "@/lib/intelligence/prep/generated-docs"
import {
  createInMemoryMeetingDatabase,
  createInMemoryMeetingRepository,
  type InMemoryMeetingDatabase,
  type RepoScope,
} from "@/lib/meetings/repository"

const NOW = new Date("2026-10-13T00:00:00.000Z")
const room = { id: "ctx_room", name: "Lisboa", kind: "room" as const, createdAt: "2026-01-01T00:00:00.000Z" }

const me: RepoScope = { kind: "member", workspaceId: "ws_a", userId: "user_me", email: "me@x.co", role: "member" }
const other: RepoScope = { kind: "member", workspaceId: "ws_a", userId: "user_other", email: "other@x.co", role: "member" }

let database: InMemoryMeetingDatabase

function seed() {
  database = createInMemoryMeetingDatabase([
    testMeeting({
      id: "m_target",
      title: "עדכון עסקה Lisboa",
      status: "scheduled",
      startedAt: "2026-10-20T10:00:00.000Z",
      contexts: [room],
      participants: ["דנה"],
    }),
    testMeeting({
      id: "m_prev",
      title: "סקירת Lisboa",
      startedAt: "2026-10-01T10:00:00.000Z",
      contexts: [room],
      summary: {
        overview: "סוכם להמשיך ל-due diligence.",
        decisions: ["ממשיכים ל-due diligence"],
        actionItems: [
          { id: "ai_open", title: "לשלוח את ה-term sheet", owner: "דנה", status: "open", dueDate: "2026-10-18" },
          { id: "ai_done", title: "סגור", status: "done" },
        ],
      },
    }),
    testMeeting({
      id: "m_secret",
      title: "Lisboa — שיחה פרטית",
      startedAt: "2026-10-05T10:00:00.000Z",
      contexts: [room],
      visibility: "private",
      ownerUserId: "user_me",
      summary: { overview: "מחיר רצפה סודי 4.2M", decisions: ["מחיר רצפה סודי"], actionItems: [] },
    }),
  ])
}

const repoFor = (scope: RepoScope) => createInMemoryMeetingRepository(database, scope)

function llmResult(value: PrepBriefOutput) {
  return {
    value,
    provider: "gemini",
    model: "gemini-3.5-flash",
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    costUsd: null,
    latencyMs: 1,
    attempts: [],
    fallbackUsed: false,
    aiRunId: "run_prep",
  }
}

const output: PrepBriefOutput = {
  goal: "לסגור את תנאי העסקה",
  whereWeLeftOff: [
    { text: "סוכם להמשיך ל-due diligence", meeting: "M1" },
    { text: "המצאה", meeting: "M9" },
  ],
  openTasks: [{ task: "T1" }, { task: "T9" }, { task: "T1" }],
  previousDecisions: [{ text: "ממשיכים ל-due diligence", meeting: "M1" }],
  suggestedQuestions: ["מה הסטטוס של ה-term sheet?", " "],
  suggestedAgenda: ["סטטוס", "צעדים הבאים"],
}

beforeEach(() => {
  seed()
  resetMemoryGeneratedDocs()
  generateStructured.mockReset()
  generateStructured.mockResolvedValue(llmResult(output))
})

async function target(scope: RepoScope) {
  return (await repoFor(scope).getMeeting("m_target"))!
}

describe("generatePrepBrief", () => {
  it("cites only related meetings and tasks the user can see", async () => {
    const result = await generatePrepBrief(other, repoFor(other), await target(other), { now: NOW })
    const request = generateStructured.mock.calls[0][0] as LlmStructuredRequest<PrepBriefOutput>

    expect(request).toMatchObject({
      task: "prep_brief",
      language: "he",
      ctx: { workspaceId: "ws_a", meetingId: "m_target", promptVersion: "m5.prep.1" },
    })
    expect(request.instructions).toContain("[M1]")
    expect(request.instructions).toContain("[T1] לשלוח את ה-term sheet — דנה — 18.10.2026")
    expect(request.instructions).not.toContain("סודי")
    expect(request.instructions).not.toContain("סגור")
    expect(result.related.map((item) => item.meetingId)).toEqual(["m_prev"])
    expect(result.brief).toEqual({
      goal: "לסגור את תנאי העסקה",
      whereWeLeftOff: [{ text: "סוכם להמשיך ל-due diligence", meetingId: "m_prev" }],
      openTasks: [{ taskId: "ai_open", title: "לשלוח את ה-term sheet", meetingId: "m_prev", owner: "דנה", due: "18.10.2026" }],
      previousDecisions: [{ text: "ממשיכים ל-due diligence", meetingId: "m_prev" }],
      suggestedQuestions: ["מה הסטטוס של ה-term sheet?"],
      suggestedAgenda: ["סטטוס", "צעדים הבאים"],
    })
    expect(request.validate!(output)).toEqual(["unknown meeting id M9", "unknown task id T9"])
  })

  it("serves an unchanged brief from cache and regenerates on force", async () => {
    await generatePrepBrief(other, repoFor(other), await target(other), { now: NOW })
    const again = await generatePrepBrief(other, repoFor(other), await target(other), { now: NOW })

    expect(again.cached).toBe(true)
    expect(generateStructured).toHaveBeenCalledTimes(1)

    await generatePrepBrief(other, repoFor(other), await target(other), { now: NOW, force: true })
    expect(generateStructured).toHaveBeenCalledTimes(2)
  })

  it("propagates LLM errors", async () => {
    generateStructured.mockRejectedValue(new LlmError("no key", "config", "none", false))

    await expect(generatePrepBrief(other, repoFor(other), await target(other), { now: NOW })).rejects.toThrow(
      "no key"
    )
  })
})

describe("getPrepBrief", () => {
  it("returns related meetings and no brief before generation", async () => {
    const result = await getPrepBrief(other, repoFor(other), await target(other), { now: NOW })

    expect(result).toMatchObject({ brief: null, language: "he" })
    expect(result.related).toHaveLength(1)
  })

  it("never serves a brief built from a meeting the reader cannot see", async () => {
    await generatePrepBrief(me, repoFor(me), await target(me), { now: NOW })
    const prompt = (generateStructured.mock.calls[0][0] as LlmStructuredRequest<PrepBriefOutput>).instructions

    expect(prompt).toContain("סודי")
    const own = await getPrepBrief(me, repoFor(me), await target(me), { now: NOW })
    const foreign = await getPrepBrief(other, repoFor(other), await target(other), { now: NOW })

    expect(own.brief).not.toBeNull()
    expect(own.stale).toBe(false)
    expect(foreign).toMatchObject({ brief: null, stale: true })
  })
})

describe("/api/meetings/:id/prep", () => {
  it("lets a viewer read and generate, and 404s invisible meetings", async () => {
    setRouteCtx(await createTestCtx({ role: "viewer", userId: "user_other", email: "other@x.co", database }))

    const empty = await (await GET(new Request("http://x/api/meetings/m_target/prep"), routeParams({ id: "m_target" }))).json()

    expect(empty.brief).toBeNull()
    const generated = await POST(jsonRequest("http://x/api/meetings/m_target/prep", "POST", { language: "en" }), routeParams({ id: "m_target" }))

    expect(generated.status).toBe(200)
    expect((await generated.json()).language).toBe("en")
    expect((await POST(jsonRequest("http://x", "POST", {}), routeParams({ id: "m_secret" }))).status).toBe(404)
  })

  it("validates input and maps LLM errors", async () => {
    setRouteCtx(await createTestCtx({ role: "member", database }))

    expect((await POST(jsonRequest("http://x", "POST", { language: "fr" }), routeParams({ id: "m_target" }))).status).toBe(400)
    expect((await GET(new Request("http://x/prep?language=fr"), routeParams({ id: "m_target" }))).status).toBe(400)
    generateStructured.mockRejectedValue(new LlmError("no key", "config", "none", false))
    const unconfigured = await POST(jsonRequest("http://x", "POST", {}), routeParams({ id: "m_target" }))

    expect(unconfigured.status).toBe(503)
    expect(await unconfigured.json()).toEqual({ error: "llm_not_configured", kind: "config" })
    generateStructured.mockRejectedValue(new LlmError("boom", "server", "gemini", true))
    expect((await POST(jsonRequest("http://x", "POST", {}), routeParams({ id: "m_target" }))).status).toBe(502)
  })
})
