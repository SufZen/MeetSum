import { readFileSync } from "node:fs"
import path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { ProviderError } from "@/lib/integrations/core/types"
import { deliverNotionPage } from "@/lib/integrations/notion/deliver"
import { setManualExportRuntime, type ManualExportRuntime } from "@/lib/integrations/notion/manual-export-runtime"
import { exchangeNotionCode, notionAuthorizeUrl, refreshNotionToken } from "@/lib/integrations/notion/oauth"
import { notionProvider, pickNotionDatabases } from "@/lib/integrations/notion/provider"
import type { MeetingRecap } from "@/lib/integrations/recap"

import { connectionDto, deliverInput, json, memoryLinkStore, on, scriptedFetch } from "./helpers/integration-doubles"

/**
 * M8 C1 Notion provider against recorded fixtures: OAuth, the database
 * picker, create + append with resume, re-export in place, 404 → new page,
 * unchanged hash no-op. Notion's error messages never surface.
 */
const fixture = (name: string) =>
  JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures/integrations/notion", name), "utf8"))

const DATABASE_ID = "8a1f0c2e-1d6b-4b8e-9b37-1f2d3c4b5a60"
const PAGE = fixture("page-created.json")
const ENV = { NOTION_CLIENT_ID: "client-id", NOTION_CLIENT_SECRET: "client-secret" } as unknown as NodeJS.ProcessEnv

function recap(segments = 250): MeetingRecap {
  return {
    meetingId: "meet_1",
    title: "סנכרון שבועי",
    language: "he",
    dir: "rtl",
    startedAt: "2026-10-12T07:30:00.000Z",
    participants: [{ name: "דנה" }],
    overview: "סיכום קצר",
    actionItems: [{ id: "act_1", title: "לשלוח תוכנית", status: "open" }],
    decisions: ["משחררים"],
    openQuestions: [],
    transcript: Array.from({ length: segments }, (_, index) => ({ startMs: index * 1000, speaker: "דנה", text: `קטע ${index}` })),
    links: { meeting: "https://meetsum.example.com/he?meeting=meet_1" },
    visibility: "workspace",
  }
}

const destination = { provider: "notion" as const, databaseId: DATABASE_ID, databaseTitle: "Meeting notes" }

function notionApi(extra: Parameters<typeof scriptedFetch>[0] = []) {
  return scriptedFetch([
    ...extra,
    on("GET", `/v1/databases/${DATABASE_ID}`, () => json(fixture("database.json"))),
    on("POST", "/v1/pages", () => json(PAGE)),
    on("PATCH", /^\/v1\/blocks\/[^/]+\/children$/, () => json({ object: "list", results: [] })),
    on("PATCH", "/v1/pages/", () => json(PAGE)),
    on("GET", /^\/v1\/blocks\/[^/]+\/children/, () => json({ object: "list", results: [], has_more: false })),
    on("DELETE", "/v1/blocks/", () => json({ object: "block", archived: true })),
  ])
}

afterEach(() => {
  setManualExportRuntime(undefined)
})

describe("Notion OAuth", () => {
  it("builds the authorize URL with owner=user and never PKCE", () => {
    const url = new URL(notionAuthorizeUrl({ state: "st", redirectUri: "https://app.example.com/cb" }, ENV))

    expect(url.origin + url.pathname).toBe("https://api.notion.com/v1/oauth/authorize")
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "client-id",
      response_type: "code",
      owner: "user",
      redirect_uri: "https://app.example.com/cb",
      state: "st",
    })
    expect(notionProvider.oauth?.pkce).toBe(false)
  })

  it("rewrites the authorize origin to the loopback fake server outside production only", () => {
    const fake = { ...ENV, MEETSUM_INTEGRATIONS_FAKE_BASE_URL: "http://127.0.0.1:4010" } as NodeJS.ProcessEnv

    expect(notionAuthorizeUrl({ state: "s", redirectUri: "r" }, fake)).toMatch(/^http:\/\/127\.0\.0\.1:4010\/v1\/oauth\/authorize/)
    expect(
      notionAuthorizeUrl({ state: "s", redirectUri: "r" }, { ...fake, NODE_ENV: "production" } as NodeJS.ProcessEnv)
    ).toMatch(/^https:\/\/api\.notion\.com/)
  })

  it("exchanges the code with Basic auth; the account is the Notion workspace", async () => {
    const { fetch, calls } = scriptedFetch([on("POST", "/v1/oauth/token", () => json(fixture("oauth-token.json")))])
    const result = await exchangeNotionCode("code_1", { redirectUri: "https://app.example.com/cb" }, { fetch, env: ENV })

    expect(calls[0].provider).toBe("notion")
    expect(calls[0].headers.authorization).toBe(`Basic ${Buffer.from("client-id:client-secret").toString("base64")}`)
    expect(calls[0].body).toEqual({ grant_type: "authorization_code", code: "code_1", redirect_uri: "https://app.example.com/cb" })
    expect(result).toMatchObject({
      accessToken: "ntn_fixture_access_token_000000000000000000000000",
      refreshToken: "nrt_fixture_refresh_token_00000000000000000000000",
      account: { externalId: "w0r1k2s3-0000-4000-8000-000000000002", label: "צוות מוצר" },
      config: { botId: "b0t1d2e3-0000-4000-8000-000000000001" },
    })
  })

  it("maps an exchange error to a fixed code without Notion's description", async () => {
    const { fetch } = scriptedFetch([on("POST", "/v1/oauth/token", () => json(fixture("oauth-error.json"), 400))])
    const error = await exchangeNotionCode("bad", { redirectUri: "r" }, { fetch, env: ENV }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ProviderError)
    expect(error).toMatchObject({ kind: "invalid", message: "notion_invalid_grant" })
    expect(JSON.stringify(error) + String((error as Error).message)).not.toMatch(/revoked|client_secret|shhh/)
  })

  it("refreshes with grant_type=refresh_token; invalid_grant → auth (needs reauth)", async () => {
    const ok = scriptedFetch([on("POST", "/v1/oauth/token", () => json(fixture("oauth-token.json")))])

    await expect(refreshNotionToken("rt", { fetch: ok.fetch, env: ENV })).resolves.toMatchObject({ accessToken: expect.any(String) })
    expect(ok.calls[0].body).toEqual({ grant_type: "refresh_token", refresh_token: "rt" })

    const bad = scriptedFetch([on("POST", "/v1/oauth/token", () => json({ error: "invalid_grant" }, 400))])

    await expect(refreshNotionToken("rt", { fetch: bad.fetch, env: ENV })).rejects.toMatchObject({ kind: "auth" })
  })

  it("fails closed when no providerFetch is registered", async () => {
    await expect(notionProvider.oauth!.exchangeCode("c", { redirectUri: "r" })).rejects.toMatchObject({ kind: "config" })
    setManualExportRuntime({ providerFetch: scriptedFetch([on("POST", "/v1/oauth/token", () => json(fixture("oauth-token.json")))]).fetch } as unknown as ManualExportRuntime)
    vi.stubEnv("NOTION_CLIENT_ID", "client-id")
    vi.stubEnv("NOTION_CLIENT_SECRET", "client-secret")
    await expect(notionProvider.oauth!.exchangeCode("c", { redirectUri: "r" })).resolves.toMatchObject({ accessToken: expect.any(String) })
    vi.unstubAllEnvs()
  })
})

describe("Notion database picker", () => {
  it("lists databases with plain-text titles and paginates", async () => {
    const { fetch, calls } = scriptedFetch([on("POST", "/v1/search", () => json(fixture("search-databases.json")))])
    const page = await pickNotionDatabases(
      { workspaceId: "ws_1", connection: connectionDto("notion"), getAccessToken: async () => "tok", fetch },
      { query: "פגישות", cursor: "cursor_1" }
    )

    expect(calls[0].body).toEqual({
      query: "פגישות",
      filter: { property: "object", value: "database" },
      page_size: 50,
      start_cursor: "cursor_1",
    })
    expect(calls[0].headers["notion-version"]).toBe("2022-06-28")
    expect(calls[0].headers.authorization).toBe("Bearer tok")
    expect(page).toEqual({
      items: [
        { id: "8a1f0c2e-1d6b-4b8e-9b37-1f2d3c4b5a60", label: "Meeting notes" },
        { id: "2b7d9e40-5c1a-4f3e-8d2b-6a7c8e9f0a11", label: "סיכומי פגישות" },
      ],
      nextCursor: "cursor_page_2",
    })
  })
})

describe("deliverNotionPage", () => {
  it("creates the page with ≤ 100 children, appends the rest in batches and links it", async () => {
    const { fetch, calls } = notionApi()
    const links = memoryLinkStore()
    const input = deliverInput({ provider: "notion", fetch, recap: recap(), destination, links })
    const result = await deliverNotionPage(input)

    const create = calls.find((call) => call.method === "POST" && call.path === "/v1/pages")!
    const appends = calls.filter((call) => call.method === "PATCH" && call.path.endsWith("/children"))
    const total = (create.body as { children: unknown[] }).children.length +
      appends.reduce((sum, call) => sum + (call.body as { children: unknown[] }).children.length, 0)

    expect((create.body as { parent: unknown }).parent).toEqual({ database_id: DATABASE_ID })
    expect((create.body as { children: unknown[] }).children).toHaveLength(100)
    expect(appends.every((call) => (call.body as { children: unknown[] }).children.length <= 100)).toBe(true)
    expect(total).toBeGreaterThan(250)
    expect(result).toMatchObject({ status: "sent", externalRef: { pageId: PAGE.id, url: PAGE.url, updated: false } })
    expect(links.rows).toEqual([
      expect.objectContaining({ objectKind: "notion_page", destinationKey: DATABASE_ID, externalId: PAGE.id, contentHash: expect.any(String) }),
    ])
    // progress holds ids only.
    expect(JSON.stringify(input.saved)).not.toMatch(/קטע|סנכרון/)
  })

  it("resumes after a failure on batch 2 without creating a second page", async () => {
    let failNext = true
    const first = notionApi([
      on("PATCH", /^\/v1\/blocks\/[^/]+\/children$/, () => {
        if (!failNext) return json({ object: "list", results: [] })
        failNext = false

        return json({ object: "error", status: 502, code: "service_unavailable", message: "x" }, 502)
      }),
    ])
    const links = memoryLinkStore()
    const input = deliverInput({ provider: "notion", fetch: first.fetch, recap: recap(), destination, links })

    await expect(deliverNotionPage(input)).rejects.toMatchObject({ kind: "retryable" })
    expect(links.rows).toHaveLength(0)

    const progress = input.saved[input.saved.length - 1]

    expect(progress).toMatchObject({ mode: "create", pageId: PAGE.id, appendedBatches: 1 })

    const second = notionApi()
    const resumed = await deliverNotionPage(
      deliverInput({ provider: "notion", fetch: second.fetch, recap: recap(), destination, links, progress })
    )

    expect(second.calls.some((call) => call.method === "POST" && call.path === "/v1/pages")).toBe(false)
    expect(second.calls.filter((call) => call.method === "PATCH" && call.path.endsWith("/children")).length).toBeGreaterThan(0)
    expect(resumed).toMatchObject({ status: "sent", externalRef: { pageId: PAGE.id } })
    expect(links.rows).toHaveLength(1)
  })

  it("re-export updates the tracked page in place: properties, archive old children, append new", async () => {
    const links = memoryLinkStore()

    await deliverNotionPage(deliverInput({ provider: "notion", fetch: notionApi().fetch, recap: recap(10), destination, links }))

    let listed = false
    const second = notionApi([
      on("GET", /^\/v1\/blocks\/[^/]+\/children/, () => {
        const results = listed ? [] : [{ id: "old_1" }, { id: "old_2" }]
        listed = true

        return json({ object: "list", results, has_more: false })
      }),
    ])
    const changed = { ...recap(10), overview: "סיכום מעודכן" }
    const result = await deliverNotionPage(deliverInput({ provider: "notion", fetch: second.fetch, recap: changed, destination, links }))

    expect(second.calls.some((call) => call.method === "POST" && call.path === "/v1/pages")).toBe(false)
    expect(second.calls.find((call) => call.method === "PATCH" && call.path === `/v1/pages/${PAGE.id}`)?.body).toHaveProperty("properties")
    expect(second.calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual([
      "/v1/blocks/old_1",
      "/v1/blocks/old_2",
    ])
    expect(result).toMatchObject({ status: "sent", externalRef: { pageId: PAGE.id, updated: true } })
    expect(links.rows).toHaveLength(1)
  })

  it("an unchanged content hash is a no-op on the same page", async () => {
    const links = memoryLinkStore()

    await deliverNotionPage(deliverInput({ provider: "notion", fetch: notionApi().fetch, recap: recap(10), destination, links }))

    const second = notionApi()
    const result = await deliverNotionPage(deliverInput({ provider: "notion", fetch: second.fetch, recap: recap(10), destination, links }))

    expect(second.calls.filter((call) => call.method !== "GET")).toEqual([])
    expect(result).toMatchObject({ status: "sent", externalRef: { pageId: PAGE.id, unchanged: true } })
  })

  it("a 404 (or archived) tracked page → a new page, and the link moves to it", async () => {
    const links = memoryLinkStore()

    await deliverNotionPage(deliverInput({ provider: "notion", fetch: notionApi().fetch, recap: recap(10), destination, links }))

    const newPage = { ...PAGE, id: "11111111-2222-4333-8444-555555555555", url: "https://www.notion.so/new" }
    const second = scriptedFetch([
      on("PATCH", `/v1/pages/${PAGE.id}`, () => json(fixture("error-object-not-found.json"), 404)),
      on("POST", "/v1/pages", () => json(newPage)),
      on("GET", `/v1/databases/${DATABASE_ID}`, () => json(fixture("database.json"))),
      on("PATCH", /^\/v1\/blocks\/[^/]+\/children$/, () => json({ object: "list", results: [] })),
    ])
    const result = await deliverNotionPage(
      deliverInput({ provider: "notion", fetch: second.fetch, recap: { ...recap(10), overview: "חדש" }, destination, links })
    )

    expect(result).toMatchObject({ externalRef: { pageId: newPage.id, updated: false } })
    expect(links.rows).toHaveLength(1)
    expect(links.rows[0].externalId).toBe(newPage.id)
  })

  it("maps errors to fixed codes, honours Retry-After and never keeps Notion's message", async () => {
    const limited = scriptedFetch([
      on("GET", `/v1/databases/${DATABASE_ID}`, () => json(fixture("error-rate-limited.json"), 429, { "retry-after": "30" })),
    ])
    const error = await deliverNotionPage(deliverInput({ provider: "notion", fetch: limited.fetch, recap: recap(1), destination })).catch(
      (caught: unknown) => caught
    )

    expect(error).toMatchObject({ kind: "rate_limited", retryAfterMs: 30_000, message: "notion_rate_limited" })

    const missing = scriptedFetch([
      on("GET", `/v1/databases/${DATABASE_ID}`, () => json(fixture("error-object-not-found.json"), 404)),
    ])
    const notFound = (await deliverNotionPage(
      deliverInput({ provider: "notion", fetch: missing.fetch, recap: recap(1), destination })
    ).catch((caught: unknown) => caught)) as ProviderError

    expect(notFound.kind).toBe("not_found")
    expect(notFound.message).toBe("notion_object_not_found")
    expect(notFound.message).not.toMatch(/secret_internal_detail|Could not find/)
  })

  it("retries a short 429 in-request, sequentially", async () => {
    let first = true
    const sleep = vi.fn(async () => {})
    const { fetch } = notionApi([
      on("GET", `/v1/databases/${DATABASE_ID}`, () => {
        if (!first) return json(fixture("database.json"))
        first = false

        return json(fixture("error-rate-limited.json"), 429, { "retry-after": "1" })
      }),
    ])

    await expect(
      deliverNotionPage(deliverInput({ provider: "notion", fetch, recap: recap(1), destination }), { sleep })
    ).resolves.toMatchObject({ status: "sent" })
    expect(sleep).toHaveBeenCalledWith(1000)
  })
})
