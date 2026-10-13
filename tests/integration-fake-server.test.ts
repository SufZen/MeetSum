import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { providerFetchWith } from "@/lib/integrations/core/http"
import { slackCall } from "@/lib/integrations/slack/client"
import { createSlackFakeHandlers } from "@/lib/integrations/slack/fake"
import { slackAuthorizeUrl, slackExchangeCode } from "@/lib/integrations/slack/oauth"
import { createFakeProviderServer, type FakeProviderServer } from "@/lib/integrations/testing/fake-server"

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
