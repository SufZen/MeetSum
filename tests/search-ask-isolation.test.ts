/**
 * M6 cross-package isolation suite (docs/parity/m6.md, Integration step 3).
 *
 * Two workspaces (W1 = ws_a, W2 = ws_b) on every engine the app can run:
 * the memory engine (A's real chunker + normalizer), and, when PGlite loads,
 * the Postgres engine over PGlite (migration 025, real scoped SQL legs) with
 * every statement recorded. Nothing in search or retrieval is faked; only the
 * LLM stream is scripted, and it cites every alias the prompt offered, so a
 * leaked passage would surface as a citation.
 *
 * Covered for members, viewers, admins, the private meeting's owner, API keys
 * with and without an owner, and a W2 owner:
 *   - search (meeting groups and chunks), facets, the compat search routes,
 *     retrieve and ask (meeting, room and workspace scope) never return W2 ids
 *     or private meetings the principal can't see;
 *   - an invisible meeting or a foreign room is a 404, not a 403;
 *   - user X's thread is a 404 for Y, an admin and W2; API keys get 403;
 *   - a citation to a meeting made private later renders `unavailable`;
 *   - the MCP tools (over the real routes with an API key) leak nothing.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { createTestCtx, routeParams, setRouteCtx } from "./helpers/route-ctx"

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authz")>()
  const { mockAuthzModule } = await import("./helpers/route-ctx")

  return mockAuthzModule(actual)
})

import { POST as askRoute } from "@/app/api/ask/route"
import { GET as threadRoute } from "@/app/api/ask/threads/[id]/route"
import { GET as threadsRoute } from "@/app/api/ask/threads/route"
import { POST as meetingAskRoute } from "@/app/api/meetings/[id]/ask/route"
import { GET as legacySearchRoute } from "@/app/api/meetings/search/route"
import { POST as memoryAskRoute } from "@/app/api/memory/ask/route"
import { GET as memorySearchRoute } from "@/app/api/memory/search/route"
import { POST as roomAskRoute } from "@/app/api/rooms/[id]/ask/route"
import { GET as facetsRoute } from "@/app/api/search/facets/route"
import { GET as searchRoute } from "@/app/api/search/route"
import type { LlmStreamEvent, LlmStreamRequest } from "@/lib/ai/llm/types"
import { askOnce, resetAskCountersForTesting, setAskDepsForTesting } from "@/lib/ask/service"
import { resetMemoryThreadStoreForTesting } from "@/lib/ask/thread-store"
import type { AuthContext } from "@/lib/auth/authz"
import { createInMemoryMeetingDatabase, type InMemoryMeetingDatabase, type MeetingRecord } from "@/lib/meetings/repository"
import { setRateLimitStoreForTesting } from "@/lib/rate-limit"
import { searchContextFrom } from "@/lib/search/context"
import { createPgliteSearchDb, seedPgliteMeetings, type PgliteSearchDb } from "@/lib/search/eval/pglite"
import { createMemorySearchEngine, defaultChunkMeeting } from "@/lib/search/memory-engine"
import { createPgSearchEngine } from "@/lib/search/pg-engine"
import { retrievePassages } from "@/lib/search/retrieve"
import { setSearchEngineForTesting, type SearchEngine } from "@/lib/search/service"
import type { WorkspaceRole } from "@/lib/workspaces/types"

import * as mcpTools from "../mcp/tools.mjs"
import { COLLIDING_TERM, searchCorpus } from "./helpers/search-fixtures"

const ROOMS = {
  room_fin: { workspaceId: "ws_a", name: "כספים" },
  room_hr: { workspaceId: "ws_a", name: "משאבי אנוש" },
  room_w2: { workspaceId: "ws_b", name: "W2 room" },
} as const

/** The shared corpus plus tags/rooms on the private and W2 meetings (facet leaks). */
function corpus(): MeetingRecord[] {
  return searchCorpus().map((meeting) => {
    if (meeting.id === "m_private") return { ...meeting, tags: ["secret-tag"] }
    if (meeting.id === "m_w2") {
      return {
        ...meeting,
        tags: ["w2-tag"],
        contexts: [{ id: "room_w2", name: ROOMS.room_w2.name, createdAt: "2026-01-01T00:00:00.000Z" }],
      }
    }
    return meeting
  })
}

function seedDatabase(): InMemoryMeetingDatabase {
  const db = createInMemoryMeetingDatabase(corpus())

  for (const [id, room] of Object.entries(ROOMS)) {
    db.contexts.set(id, { id, name: room.name, createdAt: "2026-01-01T00:00:00.000Z" })
    db.contextWorkspaces.set(id, room.workspaceId)
  }
  return db
}

type Who = {
  name: string
  role?: WorkspaceRole
  userId?: string
  workspaceId?: string
  principal?: "user" | "api_key"
  apiKeyCreatedBy?: string
  /** Meetings this principal may see (everything else must never appear). */
  visible: string[]
}

const W1_MEMBER: Who = { name: "W1 member", userId: "user_x", role: "member", visible: ["m_budget", "m_hiring"] }
const W1_OTHER: Who = { name: "W1 other member", userId: "user_y", role: "member", visible: ["m_budget", "m_hiring"] }
const W1_VIEWER: Who = { name: "W1 viewer", userId: "user_v", role: "viewer", visible: ["m_budget", "m_hiring"] }
const W1_ADMIN: Who = { name: "W1 admin", userId: "user_admin", role: "admin", visible: ["m_budget", "m_hiring"] }
const W1_PRIVATE_OWNER: Who = {
  name: "W1 private owner",
  userId: "user_owner",
  role: "member",
  visible: ["m_budget", "m_hiring", "m_private"],
}
const KEY_ORPHAN: Who = { name: "W1 API key without owner", principal: "api_key", visible: ["m_budget", "m_hiring"] }
const KEY_OWNED: Who = {
  name: "W1 API key of the private owner",
  principal: "api_key",
  apiKeyCreatedBy: "user_owner",
  visible: ["m_budget", "m_hiring", "m_private"],
}
const W2_OWNER: Who = { name: "W2 owner", userId: "user_w2", role: "owner", workspaceId: "ws_b", visible: ["m_w2"] }

const PRINCIPALS = [W1_MEMBER, W1_VIEWER, W1_ADMIN, W1_PRIVATE_OWNER, KEY_ORPHAN, KEY_OWNED, W2_OWNER]

/** Ids, titles, tags, rooms and text that identify each meeting. */
const MARKERS: Record<string, string[]> = {
  // (Not "Supabase": the fixed style guide in every prompt mentions it.)
  m_budget: ["m_budget", "ישיבת תקציב רבעונית", "room_fin", "finance", "1,200 שקל"],
  m_hiring: ["m_hiring", "גיוס מפתחים", "room_hr", "נגייס שני מפתחים"],
  m_private: ["m_private", "שיחה פרטית על תקציב", "secret-tag", "התקציב הנסתר"],
  m_w2: ["m_w2", "Workspace B", "room_w2", "w2-tag", "התקציב של B", "ws_b"],
}

function forbiddenMarkers(who: Who): string[] {
  return Object.entries(MARKERS)
    .filter(([meetingId]) => !who.visible.includes(meetingId))
    .flatMap(([, markers]) => markers)
}

function expectNoLeak(who: Who, value: unknown, where: string) {
  const text = typeof value === "string" ? value : JSON.stringify(value)

  for (const marker of forbiddenMarkers(who)) {
    expect(text.includes(marker), `${who.name}: ${where} leaked ${marker}`).toBe(false)
  }
}

let database: InMemoryMeetingDatabase

async function ctxOf(who: Who): Promise<AuthContext> {
  return createTestCtx({
    database,
    role: who.role ?? "member",
    userId: who.userId,
    email: who.userId ? `${who.userId}@example.com` : undefined,
    workspaceId: who.workspaceId ?? "ws_a",
    principal: who.principal,
    apiKeyCreatedBy: who.apiKeyCreatedBy,
  })
}

async function as(who: Who): Promise<AuthContext> {
  const ctx = await ctxOf(who)

  setRouteCtx(ctx)
  return ctx
}

const BASE = "http://localhost/api"
const get = (handler: typeof searchRoute, path: string) => handler(new Request(`${BASE}${path}`), routeParams({}))

function postJson<P>(handler: (request: Request, route: { params: Promise<P> }) => Promise<Response>, path: string, body: unknown, params: P) {
  return handler(
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    }),
    routeParams(params)
  )
}

/** Scripted LLM: one cited sentence per offered alias (up to 12) and records the prompt. */
const prompts: string[] = []

function citingStream() {
  return async function* (req: LlmStreamRequest): AsyncGenerator<LlmStreamEvent> {
    const prompt = JSON.stringify({ system: req.system, messages: req.messages })
    const aliases = [...new Set([...prompt.matchAll(/\[([sa]\d+)\b/g)].map((match) => match[1]))].slice(0, 12)
    const text = aliases.map((alias) => `זה מה שנאמר בפגישה לגבי התקציב [${alias}].`).join(" ")

    prompts.push(prompt)
    yield { type: "start", provider: "gemini", model: "gemini-test" }
    yield { type: "delta", text }
    yield {
      type: "done",
      provider: "gemini",
      model: "gemini-test",
      text,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0,
      latencyMs: 1,
      attempts: [],
    }
  }
}

/* ------------------------------------------------------------------ engines */

type Recorded = { text: string; values: unknown[]; workspaceId: string }

let pglite: PgliteSearchDb | null = null
const recorded: Recorded[] = []
let currentWorkspace = "ws_a"

function lexicalCaps(hebrew: boolean) {
  return async () => ({
    vector: { available: false, tableReady: false, indexReady: false },
    trgm: { installed: true, hebrew },
    embeddingKey: null,
    checkedAt: "now",
  })
}

function recordingPgEngine(db: PgliteSearchDb): SearchEngine {
  const query = async (text: string, values?: unknown[]) => {
    recorded.push({ text, values: values ?? [], workspaceId: currentWorkspace })

    return db.client.query(text, values)
  }

  return createPgSearchEngine({
    client: { query, connect: async () => ({ query, release: () => undefined }) },
    capabilities: lexicalCaps(db.hebrewTrigrams),
  })
}

const ENGINES: { name: string; create: () => SearchEngine | null }[] = [
  { name: "memory engine", create: () => createMemorySearchEngine() },
  { name: "recording pg engine on PGlite", create: () => (pglite ? recordingPgEngine(pglite) : null) },
]

beforeAll(async () => {
  pglite = await createPgliteSearchDb()
  if (pglite) await seedPgliteMeetings(pglite, corpus(), defaultChunkMeeting)
}, 120_000)

afterAll(async () => {
  await pglite?.close()
})

beforeEach(() => {
  database = seedDatabase()
  prompts.length = 0
  resetMemoryThreadStoreForTesting()
  resetAskCountersForTesting()
  setRateLimitStoreForTesting(new Map())
  // Many requests per principal; the limits have their own tests.
  process.env.MEETSUM_RATE_LIMIT = "false"
  delete process.env.MEETSUM_STORAGE
  setAskDepsForTesting({ stream: citingStream(), settings: async () => ({}) })
})

afterEach(() => {
  setRouteCtx(undefined)
  setSearchEngineForTesting(undefined)
  setAskDepsForTesting(undefined)
  setRateLimitStoreForTesting(undefined)
  delete process.env.MEETSUM_RATE_LIMIT
})

/* -------------------------------------------------------------- the suite */

describe.each(ENGINES)("isolation on the $name", ({ name, create }) => {
  let engine: SearchEngine | null

  beforeEach(() => {
    engine = create()
    recorded.length = 0
    if (engine) setSearchEngineForTesting(engine)
  })

  for (const who of PRINCIPALS) {
    it(`${who.name}: search, facets and compat search routes stay inside what it may see`, async () => {
      if (!engine) return
      await as(who)
      currentWorkspace = who.workspaceId ?? "ws_a"

      for (const q of ["תקציב", COLLIDING_TERM, "התקציב הנסתר", "Workspace B"]) {
        for (const group of ["meeting", "chunk"]) {
          const response = await get(searchRoute, `/search?q=${encodeURIComponent(q)}&group=${group}`)

          expect(response.status, `${name} ${who.name} ${q} ${group}`).toBe(200)

          const body = await response.json()
          const ids = [
            ...(body.groups ?? []).map((g: { meeting: { id: string } }) => g.meeting.id),
            ...(body.hits ?? []).map((h: { meetingId: string }) => h.meetingId),
          ]

          for (const id of ids) expect(who.visible, `${name} ${who.name} ${q}`).toContain(id)
          // `query` echoes the caller's own input; everything else is checked.
          expectNoLeak(who, { ...body, query: undefined }, `search ${q} ${group}`)
        }
      }

      const facets = await get(facetsRoute, "/search/facets")

      expect(facets.status).toBe(200)
      expectNoLeak(who, await facets.json(), "facets")

      for (const path of [`/meetings/search?q=${encodeURIComponent("תקציב")}`, `/memory/search?query=${encodeURIComponent("תקציב")}`]) {
        const response = await get(path.startsWith("/memory") ? memorySearchRoute : legacySearchRoute, path)

        expect(response.status, path).toBe(200)
        expectNoLeak(who, await response.json(), path)
      }

      // A filter naming a foreign or invisible meeting returns nothing about it.
      for (const meetingId of ["m_w2", "m_private"].filter((id) => !who.visible.includes(id))) {
        const body = await (await get(searchRoute, `/search?q=${encodeURIComponent("תקציב")}&meetingId=${meetingId}`)).json()

        expect(body.groups ?? [], meetingId).toEqual([])
        expectNoLeak(who, { ...body, query: undefined }, `search meetingId=${meetingId}`)
      }
    })

    it(`${who.name}: retrieve and ask in every scope cite only visible meetings`, async () => {
      if (!engine) return
      const ctx = await as(who)
      currentWorkspace = who.workspaceId ?? "ws_a"

      const retrieved = await retrievePassages(searchContextFrom(ctx), { question: `תקציב ${COLLIDING_TERM}`, scope: { kind: "workspace" } })

      expect(retrieved.passages.length, `${name} ${who.name}`).toBeGreaterThan(0)
      for (const passage of retrieved.passages) {
        expect(passage.chunk.workspaceId).toBe(who.workspaceId ?? "ws_a")
        expect(who.visible).toContain(passage.chunk.meetingId)
      }
      expectNoLeak(who, retrieved, "retrieve")

      const ownRoom = who.workspaceId === "ws_b" ? "room_w2" : "room_fin"
      const scopes = [
        { kind: "workspace" },
        { kind: "room", roomId: ownRoom },
        ...who.visible.map((meetingId) => ({ kind: "meeting", meetingId })),
      ]

      for (const scope of scopes) {
        const response = await postJson(askRoute, "/ask", { question: `מה נאמר על התקציב ועל ${COLLIDING_TERM}?`, scope }, {})
        const body = await response.json()

        expect(response.status, `${name} ${who.name} ${JSON.stringify(scope)}`).toBe(200)
        for (const citation of body.citations ?? []) expect(who.visible).toContain(citation.meetingId)
        expectNoLeak(who, body, `ask ${JSON.stringify(scope)}`)
      }

      // Every prompt the LLM saw for this principal is clean too.
      expect(prompts.length).toBeGreaterThan(0)
      for (const prompt of prompts) expectNoLeak(who, prompt, "LLM prompt")
    })

    it(`${who.name}: invisible meetings and foreign rooms are 404s on every ask entry point`, async () => {
      if (!engine) return
      await as(who)

      const question = { question: "מה הוחלט על התקציב?" }
      const invisible = Object.keys(MARKERS).filter((id) => !who.visible.includes(id))
      const foreignRooms = Object.entries(ROOMS)
        .filter(([, room]) => room.workspaceId !== (who.workspaceId ?? "ws_a"))
        .map(([id]) => id)

      for (const meetingId of invisible) {
        const ask = await postJson(askRoute, "/ask", { ...question, scope: { kind: "meeting", meetingId } }, {})
        const compat = await postJson(meetingAskRoute, `/meetings/${meetingId}/ask`, question, { id: meetingId })

        for (const response of [ask, compat]) {
          expect(response.status, `${who.name} ${meetingId}`).toBe(404)
          expectNoLeak(who, await response.text(), `ask 404 ${meetingId}`)
        }
      }
      for (const roomId of foreignRooms) {
        const ask = await postJson(askRoute, "/ask", { ...question, scope: { kind: "room", roomId } }, {})
        const compat = await postJson(roomAskRoute, `/rooms/${roomId}/ask`, question, { id: roomId })

        for (const response of [ask, compat]) {
          expect(response.status, `${who.name} ${roomId}`).toBe(404)
          expectNoLeak(who, await response.text(), `ask 404 ${roomId}`)
        }
      }

      const memoryAsk = await postJson(memoryAskRoute, "/memory/ask", question, {})

      expectNoLeak(who, await memoryAsk.text(), "memory/ask")
      for (const prompt of prompts) expectNoLeak(who, prompt, "LLM prompt")
    })
  }

  it("every pg statement for W1 and W2 principals binds only its own workspace", async () => {
    if (!engine || name.startsWith("memory")) return

    for (const who of [W1_MEMBER, KEY_ORPHAN, W2_OWNER]) {
      recorded.length = 0
      currentWorkspace = who.workspaceId ?? "ws_a"

      const ctx = await as(who)

      await get(searchRoute, `/search?q=${encodeURIComponent("תקציב")}&group=chunk`)
      await get(facetsRoute, "/search/facets")
      await retrievePassages(searchContextFrom(ctx), { question: "תקציב", scope: { kind: "workspace" } })

      const other = currentWorkspace === "ws_a" ? "ws_b" : "ws_a"
      const scoped = recorded.filter((call) => /\b(meeting_chunks|meetings)\b/.test(call.text))

      expect(scoped.length, who.name).toBeGreaterThan(0)
      for (const call of scoped) {
        expect(call.text, who.name).toMatch(/workspace_id/)
        expect(call.values, who.name).toContain(currentWorkspace)
        expect(call.values, who.name).not.toContain(other)
      }
    }
  })
})

describe("threads are private (memory engine)", () => {
  beforeEach(() => setSearchEngineForTesting(createMemorySearchEngine()))

  async function createThreadAsX(): Promise<string> {
    const ctx = await ctxOf(W1_MEMBER)
    const result = await askOnce(ctx, { question: "מה הוחלט על התקציב?", scope: { kind: "workspace" } })

    expect(result.status).toBe("complete")
    expect(result.threadId).toBeTruthy()
    expect(result.citations.some((citation) => citation.meetingId === "m_budget")).toBe(true)
    return result.threadId!
  }

  const getThread = (id: string) => threadRoute(new Request(`${BASE}/ask/threads/${id}`), routeParams({ id }))

  it("user X's thread is a 404 for Y, an admin and W2, and a 403 for API keys", async () => {
    const threadId = await createThreadAsX()

    await as(W1_MEMBER)
    expect((await getThread(threadId)).status).toBe(200)

    for (const who of [W1_OTHER, W1_ADMIN, W1_PRIVATE_OWNER, W2_OWNER]) {
      await as(who)

      const response = await getThread(threadId)
      const list = await (await threadsRoute(new Request(`${BASE}/ask/threads`), routeParams({}))).json()

      expect(response.status, who.name).toBe(404)
      expect(JSON.stringify(list), who.name).not.toContain(threadId)
      expect(await response.text(), who.name).not.toContain("התקציב")
    }

    for (const who of [KEY_ORPHAN, KEY_OWNED]) {
      await as(who)
      expect((await getThread(threadId)).status, who.name).toBe(403)
      expect((await threadsRoute(new Request(`${BASE}/ask/threads`), routeParams({}))).status, who.name).toBe(403)
    }
  })

  it("a citation to a meeting made private later renders unavailable", async () => {
    const threadId = await createThreadAsX()
    const budget = database.meetings.get("m_budget")!

    database.meetings.set("m_budget", { ...budget, visibility: "private", ownerUserId: "user_owner" })
    await as(W1_MEMBER)

    const response = await getThread(threadId)
    const body = await response.json()
    const citations = body.messages.flatMap((message: { citations: Array<Record<string, unknown>> }) => message.citations)
    const budgetCitations = citations.filter((citation: { meetingId: string }) => citation.meetingId === "m_budget")

    expect(response.status).toBe(200)
    expect(budgetCitations.length).toBeGreaterThan(0)
    for (const citation of budgetCitations) {
      expect(citation).toMatchObject({ unavailable: true, meetingTitle: "", quote: "" })
      expect(citation.segmentId).toBeUndefined()
    }
    expect(JSON.stringify(body)).not.toContain("ישיבת תקציב רבעונית")
  })
})

describe("MCP tools over the real routes (memory engine)", () => {
  type Handler = (input: Record<string, unknown>) => Promise<{ content: { text: string }[] }>
  const { createRequest, registerMeetSumTools } = mcpTools as unknown as {
    createRequest: (options: { fetch: typeof fetch; appUrl: string; apiKey?: string }) => unknown
    registerMeetSumTools: (server: unknown, request: unknown, options?: { maxChars?: number }) => void
  }

  function mcp() {
    const handlers = new Map<string, Handler>()
    const routeFetch = (async (url: string, init: RequestInit = {}) => {
      const parsed = new URL(url)
      const request = new Request(`${BASE}${parsed.pathname.replace(/^\/api/, "")}${parsed.search}`, init)

      if (parsed.pathname === "/api/search") return searchRoute(request, routeParams({}))
      if (parsed.pathname === "/api/ask") return askRoute(request, routeParams({}))
      return new Response(JSON.stringify({ error: "not routed in this test" }), { status: 404 })
    }) as unknown as typeof fetch

    registerMeetSumTools(
      { registerTool: (toolName: string, _config: unknown, handler: Handler) => handlers.set(toolName, handler) },
      createRequest({ fetch: routeFetch, appUrl: "http://app.test/", apiKey: "msk_test" })
    )

    return async (toolName: string, input: Record<string, unknown>) => {
      try {
        return (await handlers.get(toolName)!(input)).content[0].text
      } catch (error) {
        return `error: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }

  beforeEach(() => setSearchEngineForTesting(createMemorySearchEngine()))

  for (const who of [KEY_ORPHAN, KEY_OWNED, W2_OWNER]) {
    it(`${who.name}: search_meetings, search_transcripts, ask and ask_meeting_memory leak nothing`, async () => {
      await as(who)

      const run = mcp()
      const outputs = [
        await run("search_meetings", { query: "תקציב" }),
        await run("search_meetings", { query: COLLIDING_TERM }),
        await run("search_transcripts", { query: "תקציב" }),
        await run("search_transcripts", { query: COLLIDING_TERM }),
        await run("ask", { question: "מה נאמר על התקציב?", scope: "workspace" }),
      ]

      for (const output of outputs) {
        expect(output.startsWith("error:"), output).toBe(false)
        expectNoLeak(who, output, "mcp")
      }

      for (const meetingId of Object.keys(MARKERS).filter((id) => !who.visible.includes(id))) {
        const output = await run("ask_meeting_memory", { meetingId, question: "מה הוחלט?" })

        expect(output.startsWith("error:"), output).toBe(true)
        expectNoLeak(who, output.replaceAll(meetingId, ""), `mcp ask_meeting_memory ${meetingId}`)
      }
    })
  }
})
