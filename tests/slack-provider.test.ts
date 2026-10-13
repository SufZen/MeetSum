import { readFileSync } from "node:fs"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { setProviderTransportForTesting } from "@/lib/integrations/core/http"
import { createLinkStore } from "@/lib/integrations/core/links"
import type { IntegrationStore } from "@/lib/integrations/core/store"
import { createMemoryIntegrationStore } from "@/lib/integrations/core/store-memory"
import type { DeliverInput, IntegrationConnectionDTO, ProviderCtx, ProviderFetch } from "@/lib/integrations/core/types"
import { buildMeetingRecap, DEFAULT_RULE_CONTENT } from "@/lib/integrations/recap"
import { slackDestinationHint } from "@/lib/integrations/slack/client"
import { slackAuthorizeUrl, slackScopes } from "@/lib/integrations/slack/oauth"
import { slackProvider } from "@/lib/integrations/slack/provider"
import { testMeetingRecord } from "@/lib/integrations/testing/harness"

/**
 * M8 A9 Slack provider against recorded fixtures: OAuth ok/error (incl.
 * Grid + rotation), conversations pagination with server-side query,
 * postMessage `not_in_channel` / `ratelimited` / `token_revoked`, and a
 * re-send that `chat.update`s the tracked message.
 */

const fixture = (name: string) => JSON.parse(readFileSync(`tests/fixtures/integrations/slack/${name}.json`, "utf8"))
const ERRORS = fixture("errors")
const MESSAGES = fixture("messages")
const CONVERSATIONS = fixture("conversations")
const ENV = {
  NODE_ENV: "test",
  SLACK_CLIENT_ID: "fixture-client",
  SLACK_CLIENT_SECRET: "fixture-secret",
} as NodeJS.ProcessEnv

type Call = { url: string; body: string; auth?: string }

function routedFetch(routes: Record<string, unknown | ((call: Call) => unknown)>, calls: Call[]): ProviderFetch {
  return async (_provider, url, init = {}) => {
    const call = { url, body: String(init.body ?? ""), auth: new Headers(init.headers).get("authorization") ?? undefined }

    calls.push(call)

    const method = url.replace("https://slack.com/api/", "")
    const route = routes[method]
    const value = typeof route === "function" ? (route as (call: Call) => unknown)(call) : route
    const { status = 200, headers = {}, body = value } = (value as { __response?: boolean; status?: number; headers?: Record<string, string>; body?: unknown })?.__response
      ? (value as { status?: number; headers?: Record<string, string>; body?: unknown })
      : { body: value }

    return new Response(JSON.stringify(body ?? { ok: false, error: "unknown_method" }), { status, headers })
  }
}

describe("Slack OAuth", () => {
  beforeEach(() => {
    vi.stubEnv("SLACK_CLIENT_ID", "fixture-client")
    vi.stubEnv("SLACK_CLIENT_SECRET", "fixture-secret")
  })
  afterEach(() => {
    setProviderTransportForTesting(undefined)
    vi.unstubAllEnvs()
  })

  it("builds the authorize URL from env scopes only", () => {
    const url = new URL(slackAuthorizeUrl({ state: "s.t", redirectUri: "https://app.test/api/integrations/slack/oauth/callback" }, ENV))

    expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize")
    expect(url.searchParams.get("scope")).toBe("chat:write,chat:write.public,channels:read,channels:history")
    expect(url.searchParams.get("client_id")).toBe("fixture-client")
    expect(url.searchParams.has("client_secret")).toBe(false)
    expect(slackScopes({ ...ENV, SLACK_PRIVATE_CHANNELS: "true" })).toEqual(expect.arrayContaining(["groups:read", "groups:history"]))
    expect(slackScopes({ ...ENV, SLACK_SCOPES: "chat:write" })).toEqual(["chat:write"])
  })

  it("exchanges a code (fixture) into account, tokens and config", async () => {
    const calls: { url: string; body: string }[] = []

    setProviderTransportForTesting(async (url, init) => {
      calls.push({ url, body: String(init.body) })
      return new Response(JSON.stringify(fixture("oauth-ok")), { status: 200 })
    })

    const result = await slackProvider.oauth!.exchangeCode("code-1", { redirectUri: "https://app.test/cb" })

    expect(result).toMatchObject({
      accessToken: "xoxb-fixture-access-token",
      account: { externalId: "T0FIXTURE", label: "Acme Hebrew Team" },
      scopes: ["chat:write", "chat:write.public", "channels:read"],
      config: { teamId: "T0FIXTURE", botUserId: "U0BOT" },
    })
    expect(calls[0].url).toBe("https://slack.com/api/oauth.v2.access")
    expect(new URLSearchParams(calls[0].body).get("code")).toBe("code-1")
  })

  it("handles Grid accounts and token rotation", async () => {
    setProviderTransportForTesting(async () => new Response(JSON.stringify(fixture("oauth-rotation")), { status: 200 }))

    const result = await slackProvider.oauth!.exchangeCode("c", { redirectUri: "https://app.test/cb" })

    expect(result.account.externalId).toBe("E0GRID:T0GRID")
    expect(result.refreshToken).toBe("xoxe-1-fixture-refresh")
    expect(Date.parse(result.expiresAt ?? "")).toBeGreaterThan(Date.now())
  })

  it("maps ok:false to an invalid ProviderError without provider text", async () => {
    setProviderTransportForTesting(async () => new Response(JSON.stringify(ERRORS.oauth_invalid_code), { status: 200 }))

    await expect(slackProvider.oauth!.exchangeCode("bad", { redirectUri: "https://app.test/cb" })).rejects.toMatchObject({
      kind: "invalid",
      providerCode: "invalid_code",
    })
  })
})

describe("Slack provider", () => {
  let store: IntegrationStore
  let calls: Call[]
  const connection: IntegrationConnectionDTO = {
    id: "intc_s",
    provider: "slack",
    status: "active",
    accountLabel: "Acme",
    scopes: ["chat:write", "chat:write.public", "channels:read"],
    createdAt: "2026-10-01T00:00:00.000Z",
    config: {},
  }

  beforeEach(async () => {
    store = createMemoryIntegrationStore()
    calls = []
    await store.createConnection({
      id: "intc_s",
      workspaceId: "ws_a",
      provider: "slack",
      status: "active",
      accountLabel: "Acme",
      externalAccountId: "T0FIXTURE",
      scopes: connection.scopes,
      config: {},
    })
  })

  function ctx(fetch: ProviderFetch): ProviderCtx {
    return { workspaceId: "ws_a", connection, getAccessToken: async () => "xoxb-fixture", fetch }
  }

  function input(fetch: ProviderFetch, overrides: Partial<DeliverInput> = {}): DeliverInput {
    const meeting = testMeetingRecord({ id: "m_a" })

    return {
      workspaceId: "ws_a",
      delivery: {
        id: "intd_1",
        provider: "slack",
        origin: "manual",
        status: "running",
        attempts: 1,
        maxAttempts: 5,
        externalRef: {},
        createdAt: "",
        updatedAt: "",
        eventName: "meeting.completed",
      },
      connection,
      getAccessToken: async () => "xoxb-fixture",
      destination: { provider: "slack", channelId: "C0GENERAL", channelName: "general" },
      content: DEFAULT_RULE_CONTENT,
      recap: buildMeetingRecap(meeting, { content: DEFAULT_RULE_CONTENT, links: { meeting: "https://app.test/he?meeting=m_a" } }),
      meeting,
      progress: {},
      saveProgress: async () => undefined,
      links: createLinkStore(store, { workspaceId: "ws_a", connectionId: "intc_s", meetingId: "m_a", provider: "slack" }),
      fetch,
      ...overrides,
    }
  }

  it("paginates the channel picker and filters by query on the server", async () => {
    const fetch = routedFetch(
      { "conversations.list": (call: Call) => (new URLSearchParams(call.body).get("cursor") ? CONVERSATIONS.page2 : CONVERSATIONS.page1) },
      calls
    )
    const first = await slackProvider.pickers!.channels(ctx(fetch), {})

    expect(first.items.map((item) => item.label)).toEqual(["#general", "#sales-team", "#random"])
    expect(first.nextCursor).toBe("dGVhbTpDMDY=")
    expect(first.items[1].hint).toBe("not_member")

    const second = await slackProvider.pickers!.channels(ctx(fetch), { cursor: first.nextCursor })

    expect(second).toEqual({ items: [{ id: "C0MEETINGS", label: "#meetings" }] })
    expect((await slackProvider.pickers!.channels(ctx(fetch), { query: "#SAL" })).items.map((item) => item.id)).toEqual(["C0SALES"])
    expect(new URLSearchParams(calls[0].body).get("exclude_archived")).toBe("true")
    expect(new URLSearchParams(calls[0].body).get("types")).toBe("public_channel")
    expect(calls[0].auth).toBe("Bearer xoxb-fixture")
  })

  it("posts the recap without unfurls, records the permalink and the link", async () => {
    const fetch = routedFetch({ "chat.postMessage": MESSAGES.post_ok, "chat.getPermalink": MESSAGES.permalink }, calls)
    const result = await slackProvider.deliver!(input(fetch))

    expect(result).toEqual({
      status: "sent",
      externalRef: { channel: "C0GENERAL", ts: "1700000000.000100", permalink: MESSAGES.permalink.permalink },
    })

    const body = JSON.parse(calls[0].body)

    expect(body).toMatchObject({ channel: "C0GENERAL", unfurl_links: false, unfurl_media: false })
    expect(body.blocks.length).toBeLessThanOrEqual(50)
    expect(
      await store.getLink({ workspaceId: "ws_a", connectionId: "intc_s", meetingId: "m_a" }, { objectKind: "slack_message", destinationKey: "C0GENERAL" })
    ).toMatchObject({ externalId: "1700000000.000100" })
  })

  it("updates the tracked message on a re-send within 24 h and no-ops an unchanged one", async () => {
    const fetch = routedFetch({ "chat.postMessage": MESSAGES.post_ok, "chat.getPermalink": MESSAGES.permalink, "chat.update": MESSAGES.update_ok }, calls)

    await slackProvider.deliver!(input(fetch))
    const unchanged = await slackProvider.deliver!(input(fetch))

    expect(unchanged.externalRef).toMatchObject({ ts: "1700000000.000100", unchanged: true })

    const changedMeeting = testMeetingRecord({ id: "m_a", title: "כותרת חדשה" })
    const updated = await slackProvider.deliver!(
      input(fetch, {
        meeting: changedMeeting,
        recap: buildMeetingRecap(changedMeeting, { content: DEFAULT_RULE_CONTENT, links: { meeting: "https://app.test/he?meeting=m_a" } }),
      })
    )

    expect(updated.externalRef).toMatchObject({ ts: "1700000000.000100", updated: true })
    expect(calls.map((call) => call.url.replace("https://slack.com/api/", ""))).toEqual([
      "chat.postMessage",
      "chat.getPermalink",
      "chat.update",
    ])
  })

  it("maps postMessage errors: not_in_channel → invalid, ratelimited → rate_limited with Retry-After, token_revoked → auth", async () => {
    await expect(slackProvider.deliver!(input(routedFetch({ "chat.postMessage": ERRORS.not_in_channel }, calls)))).rejects.toMatchObject({
      kind: "invalid",
      providerCode: "not_in_channel",
    })
    expect(slackDestinationHint("not_in_channel", "he")).toBe("יש להזמין את MeetSum לערוץ")

    await expect(
      slackProvider.deliver!(
        input(routedFetch({ "chat.postMessage": { __response: true, status: 429, headers: { "retry-after": "30" }, body: ERRORS.ratelimited } }, calls))
      )
    ).rejects.toMatchObject({ kind: "rate_limited", retryAfterMs: 30_000 })

    await expect(slackProvider.deliver!(input(routedFetch({ "chat.postMessage": ERRORS.token_revoked }, calls)))).rejects.toMatchObject({
      kind: "auth",
      providerCode: "token_revoked",
    })
  })

  it("validates a destination: archived and not-member channels are refused", async () => {
    const info = (channel: Record<string, unknown>) => routedFetch({ "conversations.info": { ok: true, channel } }, calls)

    await expect(slackProvider.validateDestination!({ provider: "slack", channelId: "C1", channelName: "x" }, ctx(info({ is_member: true })))).resolves.toBeUndefined()
    await expect(
      slackProvider.validateDestination!({ provider: "slack", channelId: "C1", channelName: "x" }, ctx(info({ is_archived: true })))
    ).rejects.toMatchObject({ providerCode: "is_archived" })
    await expect(
      slackProvider.validateDestination!({ provider: "slack", channelId: "C1", channelName: "x" }, ctx(info({ is_private: true, is_member: false })))
    ).rejects.toMatchObject({ providerCode: "not_in_channel" })
    await expect(
      slackProvider.validateDestination!({ provider: "slack", channelId: "bad id!", channelName: "x" }, ctx(info({})))
    ).rejects.toMatchObject({ kind: "invalid" })
  })
})
