import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { providerFetchWith } from "@/lib/integrations/core/http"
import { listProviders } from "@/lib/integrations/core/registry"
import { createGoogleDocument, googleDocumentEndIndex } from "@/lib/integrations/google-docs/client"
import { createHubspotClient } from "@/lib/integrations/hubspot/client"
import { FAKE_OUTLOOK_ICAL_UID } from "@/lib/integrations/microsoft/fake"
import { GRAPH_BASE, graphGet } from "@/lib/integrations/microsoft/graph"
import { notionRequest } from "@/lib/integrations/notion/client"
import { slackCall } from "@/lib/integrations/slack/client"
import { createSlackFakeHandlers } from "@/lib/integrations/slack/fake"
import { slackAuthorizeUrl, slackExchangeCode } from "@/lib/integrations/slack/oauth"
import { allProviderFakeHandlers, createFakeProviderServer, type FakeProviderServer } from "@/lib/integrations/testing/fake-server"

/**
 * The dev/e2e fake provider server on loopback: fake-mode rewriting of
 * provider URLs, the auto-approving authorize page, the Slack flow, and a
 * request log that never contains a token, secret or OAuth code.
 */

let server: FakeProviderServer
let env: NodeJS.ProcessEnv

beforeAll(async () => {
  server = await createFakeProviderServer(createSlackFakeHandlers())
  env = {
    NODE_ENV: "development",
    MEETSUM_INTEGRATIONS_FAKE_BASE_URL: server.url,
    SLACK_CLIENT_ID: "fake-client",
    SLACK_CLIENT_SECRET: "fake-secret-value",
  } as NodeJS.ProcessEnv
})

afterAll(async () => {
  await server.close()
})

describe("fake provider server", () => {
  it("auto-approves the authorize page back to the redirect URI with the state", async () => {
    const url = slackAuthorizeUrl({ state: "st.ate", redirectUri: "http://localhost:3000/api/integrations/slack/oauth/callback" }, env)

    expect(url.startsWith(`${server.url}/slack.com/oauth/v2/authorize?`)).toBe(true)

    const response = await fetch(url, { redirect: "manual" })
    const location = new URL(response.headers.get("location") ?? "")

    expect(response.status).toBe(302)
    expect(location.pathname).toBe("/api/integrations/slack/oauth/callback")
    expect(location.searchParams.get("state")).toBe("st.ate")
    expect(location.searchParams.get("code")).toBe("fake-slack-code")
  })

  it("runs the Slack exchange and a post through providerFetch in fake mode, with a redacted log", async () => {
    const fetch = vi.fn((provider: Parameters<typeof providerFetchWith>[0], url: string, init?: RequestInit) =>
      providerFetchWith(provider, url, init, { env })
    )
    const exchanged = await slackExchangeCode("fake-slack-code", { redirectUri: "http://localhost/cb" }, { env, fetch })

    expect(exchanged.account).toEqual({ externalId: "TFAKE001", label: "MeetSum Test Workspace" })

    const posted = await slackCall("chat.postMessage", { channel: "C000001", text: "hi" }, { token: exchanged.accessToken, fetch })

    expect(posted.ts).toBeDefined()

    const log = JSON.stringify(server.requests())

    expect(log).toContain("/slack.com/api/chat.postMessage")
    expect(log).not.toContain("fake-slack-bot-token")
    expect(log).not.toContain("fake-secret-value")
    expect(log).not.toContain("fake-slack-code")
  })

  it("answers 404 for unknown routes and paginates channels", async () => {
    expect((await fetch(`${server.url}/nope.test/x`)).status).toBe(404)

    const fetchFake = (provider: Parameters<typeof providerFetchWith>[0], url: string, init?: RequestInit) =>
      providerFetchWith(provider, url, init, { env })
    const first = await slackCall("conversations.list", { limit: 200 }, { token: "fake-slack-bot-token", form: true, fetch: fetchFake })
    const next = (first.response_metadata as { next_cursor: string }).next_cursor

    expect((first.channels as unknown[]).length).toBe(200)
    expect(next).toBe("page-200")
  })
})

/** `scripts/integrations-e2e-seed.ts` `E2E_M8_ICAL_UID` (importing the script would run it). */
const E2E_M8_ICAL_UID = "e2e-m8-shared-event@meetsum.test"

describe("merged fake providers (npm run integrations:fake)", () => {
  let all: FakeProviderServer
  let fakeEnv: NodeJS.ProcessEnv
  const via = (provider: Parameters<typeof providerFetchWith>[0], url: string, init?: RequestInit) =>
    providerFetchWith(provider, url, init, { env: fakeEnv })

  beforeAll(async () => {
    all = await createFakeProviderServer(allProviderFakeHandlers(listProviders()))
    fakeEnv = { NODE_ENV: "development", MEETSUM_INTEGRATIONS_FAKE_BASE_URL: all.url } as NodeJS.ProcessEnv
  })

  afterAll(async () => {
    await all.close()
  })

  it("serves host-less B/C keys, :param keys and prefix keys on each provider's hosts", async () => {
    const notion = { fetch: via, getAccessToken: async () => "fake_notion_access_token" }
    const page = await notionRequest<{ id: string }>(notion, "POST", "/v1/pages", { parent: { database_id: "db" }, properties: {}, children: [] })

    // `PATCH /v1/pages/:id` and `GET /v1/databases/:id` see the host-less path.
    await expect(notionRequest(notion, "PATCH", `/v1/pages/${page.id}`, { properties: {} })).resolves.toMatchObject({ id: page.id })
    await expect(notionRequest(notion, "GET", "/v1/databases/fake-db-7")).resolves.toMatchObject({ id: "fake-db-7" })

    const hubspot = createHubspotClient(via, "fake-hubspot-access")

    // Prefix keys (`PATCH /crm/v3/objects/meetings/`, `POST /crm/v4/associations/`).
    await expect(hubspot.request("PATCH", "/crm/v3/objects/meetings/123", { properties: {} })).resolves.toEqual({ id: "patched" })
    await expect(hubspot.request("POST", "/crm/v4/associations/meetings/contacts/batch/create", { inputs: [] })).resolves.toMatchObject({
      status: "COMPLETE",
    })

    const docs = { fetch: via, getAccessToken: async () => "fake_google_access_token" }
    const created = await createGoogleDocument(docs, "מסמך")

    await expect(googleDocumentEndIndex(docs, created.documentId)).resolves.toBeGreaterThan(0)
  })

  it("filters and clears the log per provider and records the webhook receiver with its raw body", async () => {
    await fetch(`${all.url}/__fake/requests`, { method: "DELETE" })
    await graphGet(via, "fake-ms-access", `${GRAPH_BASE}/me?$select=id`)
    await slackCall("auth.test", {}, { token: "fake-slack-bot-token", fetch: via })

    const raw = JSON.stringify({ event: "clip.created", data: { id: "c1" } })
    const hook = await fetch(`${all.url}/__fake/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-meetsum-signature-v2": "t=1,v1=abc" },
      body: raw,
    })

    expect(hook.status).toBe(200)

    const list = async (provider: string) =>
      ((await (await fetch(`${all.url}/__fake/requests?provider=${provider}`)).json()) as { requests: { path: string; provider: string; rawBody?: string; headers: Record<string, string> }[] }).requests

    expect((await list("microsoft")).map((entry) => entry.path)).toEqual(["/graph.microsoft.com/v1.0/me"])
    expect((await list("slack")).map((entry) => entry.provider)).toEqual(["slack"])

    const [received] = await list("webhook")

    expect(received?.rawBody).toBe(raw)
    expect(received?.headers["x-meetsum-signature-v2"]).toBe("t=1,v1=abc")

    await fetch(`${all.url}/__fake/requests?provider=slack`, { method: "DELETE" })
    expect(await list("slack")).toEqual([])
    expect(await list("microsoft")).toHaveLength(1)

    await fetch(`${all.url}/__fake/requests`, { method: "DELETE" })
    expect(all.requests()).toEqual([])
  })

  it("lists Slack channels over more than one page and serves the shared Outlook iCalUID", async () => {
    const pages: number[] = []
    let cursor: string | undefined

    do {
      const page = await slackCall("conversations.list", { limit: 200, ...(cursor ? { cursor } : {}) }, { token: "fake-slack-bot-token", form: true, fetch: via })

      pages.push((page.channels as unknown[]).length)
      cursor = (page.response_metadata as { next_cursor?: string }).next_cursor || undefined
    } while (cursor)

    expect(pages.length).toBeGreaterThan(1)

    const delta = await graphGet<{ value: { iCalUId: string }[] }>(via, "fake-ms-access", `${GRAPH_BASE}/me/calendarView/delta`)

    expect(delta.value.map((event) => event.iCalUId)).toContain(E2E_M8_ICAL_UID)
    expect(FAKE_OUTLOOK_ICAL_UID).toBe(E2E_M8_ICAL_UID)
  })
})
