import { describe, expect, it } from "vitest"

import * as tools from "../mcp/tools.mjs"

type Handler = (input: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>
type Call = { url: string; method: string; headers: Headers; body?: string }

const { MCP_SERVER_VERSION, createRequest, describeApiError, registerMeetSumTools, textResult } = tools as {
  MCP_SERVER_VERSION: string
  createRequest: (options: { fetch: typeof fetch; appUrl: string; apiKey?: string }) => (path: string, init?: RequestInit) => Promise<unknown>
  describeApiError: (status: number, body: unknown) => string
  registerMeetSumTools: (server: unknown, request: unknown, options?: { maxChars?: number }) => void
  textResult: (value: unknown, maxChars?: number) => { content: { text: string }[] }
}

function harness(respond: (call: Call) => { status?: number; body: unknown } = () => ({ body: {} }), maxChars?: number) {
  const calls: Call[] = []
  const handlers = new Map<string, Handler>()
  const fakeFetch = (async (url: string, init: RequestInit = {}) => {
    const call = { url, method: init.method ?? "GET", headers: new Headers(init.headers), body: init.body as string | undefined }

    calls.push(call)

    const { status = 200, body } = respond(call)

    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  }) as unknown as typeof fetch
  const server = { registerTool: (name: string, _config: unknown, handler: Handler) => handlers.set(name, handler) }

  registerMeetSumTools(server, createRequest({ fetch: fakeFetch, appUrl: "http://app.test/", apiKey: "msk_test" }), { maxChars })

  const run = async (name: string, input: Record<string, unknown> = {}) => {
    const response = await handlers.get(name)!(input)

    return JSON.parse(response.content[0].text)
  }

  return { calls, handlers, run }
}

describe("MCP tools", () => {
  it("registers the documented tools at version 0.2.0", () => {
    expect(MCP_SERVER_VERSION).toBe("0.2.0")
    expect([...harness().handlers.keys()].sort()).toEqual(
      [
        "ask",
        "ask_meeting_memory",
        "create_followup_draft",
        "get_meeting",
        "get_meeting_summary",
        "get_transcript_segments",
        "list_action_items",
        "list_meetings",
        "search_meetings",
        "search_transcripts",
        "send_context_to_realizeos",
      ].sort()
    )
  })

  it("search_meetings and search_transcripts call /api/search with filters and cursor", async () => {
    const { calls, run } = harness(() => ({ body: { groups: [{ meeting: { id: "m1" } }], hits: [], nextCursor: "c2", mode: "lexical" } }))

    expect(await run("search_meetings", { query: "תקציב", room: "r1", from: "2026-01-01", meetingType: "board", limit: 99, cursor: "c1" })).toEqual({
      groups: [{ meeting: { id: "m1" } }],
      nextCursor: "c2",
      mode: "lexical",
    })

    const url = new URL(calls[0].url)

    expect(url.pathname).toBe("/api/search")
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: "תקציב", group: "meeting", room: "r1", from: "2026-01-01", type: "board", limit: "25", cursor: "c1" })
    expect(calls[0].headers.get("authorization")).toBe("Bearer msk_test")

    await run("search_transcripts", { query: "x", limit: 40 })
    expect(new URL(calls[1].url).searchParams.get("group")).toBe("chunk")
    expect(new URL(calls[1].url).searchParams.get("limit")).toBe("40")
  })

  it("encodes ids in every path", async () => {
    const { calls, run } = harness((call) => ({
      body: call.url.includes("/transcript") ? { segments: [] } : { meeting: { title: "t", summary: { overview: "o", decisions: [] } } },
    }))

    await run("get_meeting", { meetingId: "../x" })
    await run("get_meeting_summary", { meetingId: "a/b?c" })
    await run("get_transcript_segments", { meetingId: "../x" })
    await run("create_followup_draft", { meetingId: "../x" })

    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/api/meetings/..%2Fx",
      "/api/meetings/a%2Fb%3Fc",
      "/api/meetings/..%2Fx/transcript",
      "/api/meetings/..%2Fx",
    ])
  })

  it("ask posts JSON to /api/ask per scope; the refine requires the matching id; the alias uses meeting scope", async () => {
    const { calls, run, handlers } = harness(() => ({ body: { status: "complete", content: "תשובה [1]" } }))

    await run("ask", { question: "מה הוחלט?", scope: "room", roomId: "r/1" })
    await run("ask", { question: "q", scope: "workspace" })
    await run("ask_meeting_memory", { meetingId: "../m", question: "q" })

    expect(calls.map((call) => [new URL(call.url).pathname, call.method, call.headers.get("accept")])).toEqual([
      ["/api/ask", "POST", "application/json"],
      ["/api/ask", "POST", "application/json"],
      ["/api/ask", "POST", "application/json"],
    ])
    expect(JSON.parse(calls[0].body!)).toEqual({ question: "מה הוחלט?", scope: { kind: "room", roomId: "r/1" } })
    expect(JSON.parse(calls[1].body!)).toEqual({ question: "q", scope: { kind: "workspace" } })
    expect(JSON.parse(calls[2].body!)).toEqual({ question: "q", scope: { kind: "meeting", meetingId: "../m" } })
    await expect(handlers.get("ask")!({ question: "q", scope: "meeting" })).rejects.toThrow(/meetingId is required/)
    await expect(handlers.get("ask")!({ question: "q", scope: "room" })).rejects.toThrow(/roomId is required/)
    expect(calls).toHaveLength(3)
  })

  it("list_meetings pages with an offset cursor; list_action_items makes one request", async () => {
    const { calls, run } = harness((call) =>
      call.url.includes("/api/tasks")
        ? { body: { items: [{ id: "a1" }], nextCursor: "t2" } }
        : { body: { meetings: [{ id: "m1" }, { id: "m2" }], page: { offset: 20, limit: 2, total: 30, hasMore: true } } }
    )

    expect(await run("list_meetings", { cursor: "20", limit: 2 })).toEqual({ meetings: [{ id: "m1" }, { id: "m2" }], nextCursor: "22" })
    expect(Object.fromEntries(new URL(calls[0].url).searchParams)).toEqual({ sort: "recent", limit: "2", offset: "20" })

    expect(await run("list_action_items", { status: "open", cursor: "t1" })).toEqual({ items: [{ id: "a1" }], nextCursor: "t2" })
    expect(calls).toHaveLength(2)
    expect(Object.fromEntries(new URL(calls[1].url).searchParams)).toEqual({ scope: "all", status: "open", cursor: "t1" })
  })

  it("get_transcript_segments slices and drops word timings", async () => {
    const segments = Array.from({ length: 5 }, (_, index) => ({ id: `s${index}`, text: "x", words: [{ w: 1 }] }))
    const { run } = harness(() => ({ body: { segments } }))

    expect(await run("get_transcript_segments", { meetingId: "m", offset: 1, limit: 2 })).toEqual({
      total: 5,
      offset: 1,
      segments: [{ id: "s1", text: "x" }, { id: "s2", text: "x" }],
    })
  })

  it("maps 401/403/404 to messages without server details", async () => {
    expect(describeApiError(401, {})).toMatch(/^Unauthorized: set MEETSUM_API_KEY/)
    expect(describeApiError(403, { permission: "meeting:write" })).toMatch(/needs the "write" scope/)
    expect(describeApiError(403, {})).toBe("Forbidden for this API key.")
    expect(describeApiError(404, { error: "Meeting m_secret of workspace ws_2 not found" })).toBe(
      "Not found (or not visible to this API key's workspace)."
    )

    const { run } = harness(() => ({ status: 404, body: { error: "Meeting not found" } }))

    await expect(run("get_meeting", { meetingId: "x" })).rejects.toThrow("Not found (or not visible to this API key's workspace).")
  })

  it("truncates long responses", async () => {
    expect(JSON.parse(textResult({ a: "x".repeat(10) }, 1000).content[0].text)).toEqual({ a: "xxxxxxxxxx" })

    const { run } = harness(() => ({ body: { groups: [{ meeting: { id: "m", title: "y".repeat(5000) } }], nextCursor: null } }), 1000)
    const truncated = await run("search_meetings", { query: "y" })

    expect(truncated.truncated).toBe(true)
    expect(truncated.partial.length).toBeLessThanOrEqual(1000)
  })
})
