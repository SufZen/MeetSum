import { describe, expect, it } from "vitest"

import { googleDocsAuthorizeUrl } from "@/lib/integrations/google-docs/oauth"
import { hubspotAuthorizeUrl } from "@/lib/integrations/hubspot/oauth"
import { microsoftAuthorizeUrl } from "@/lib/integrations/microsoft/oauth"
import { notionAuthorizeUrl } from "@/lib/integrations/notion/oauth"
import { slackAuthorizeUrl } from "@/lib/integrations/slack/oauth"

/**
 * M8 e2e fix #1: in fake mode EVERY provider's browser authorize URL goes
 * through `providerAuthorizeUrl`, so it lands on the fake origin with the
 * `/<host>` prefix the fake server routes on (and never on the real site).
 */

const FAKE = "http://127.0.0.1:4010"
const ENV = {
  NODE_ENV: "test",
  MEETSUM_INTEGRATIONS_FAKE_BASE_URL: FAKE,
  SLACK_CLIENT_ID: "s",
  SLACK_CLIENT_SECRET: "s",
  NOTION_CLIENT_ID: "n",
  NOTION_CLIENT_SECRET: "n",
  HUBSPOT_CLIENT_ID: "h",
  HUBSPOT_CLIENT_SECRET: "h",
  MS_CLIENT_ID: "m",
  MS_CLIENT_SECRET: "m",
  GOOGLE_DOCS_CLIENT_ID: "g",
  GOOGLE_DOCS_CLIENT_SECRET: "g",
  GOOGLE_OAUTH_CLIENT_ID: "g",
  GOOGLE_OAUTH_CLIENT_SECRET: "g",
} as unknown as NodeJS.ProcessEnv
const params = { state: "st", redirectUri: "http://127.0.0.1:3000/api/integrations/x/oauth/callback", codeChallenge: "cc" }

describe("fake-mode authorize URLs", () => {
  it.each([
    ["slack", () => slackAuthorizeUrl(params, ENV), "slack.com", "/oauth/v2/authorize"],
    ["notion", () => notionAuthorizeUrl(params, ENV), "api.notion.com", "/v1/oauth/authorize"],
    ["hubspot", () => hubspotAuthorizeUrl(params, ENV), "app.hubspot.com", "/oauth/authorize"],
    ["microsoft", () => microsoftAuthorizeUrl(params, ENV), "login.microsoftonline.com", "/oauth2/v2.0/authorize"],
    ["google_drive", () => googleDocsAuthorizeUrl(params, ENV), "accounts.google.com", "/o/oauth2/v2/auth"],
  ])("%s goes to the fake origin with the host prefix", (_provider, build, host, path) => {
    const url = new URL(build())

    expect(url.origin).toBe(FAKE)
    expect(url.pathname.startsWith(`/${host}/`)).toBe(true)
    expect(url.pathname.endsWith(path)).toBe(true)
    expect(url.searchParams.get("state")).toBe("st")
  })

  it("uses the real hosts outside fake mode", () => {
    const real = { ...ENV, MEETSUM_INTEGRATIONS_FAKE_BASE_URL: "" } as NodeJS.ProcessEnv

    expect(new URL(notionAuthorizeUrl(params, real)).host).toBe("api.notion.com")
    expect(new URL(hubspotAuthorizeUrl(params, real)).host).toBe("app.hubspot.com")
    expect(new URL(microsoftAuthorizeUrl(params, real)).host).toBe("login.microsoftonline.com")
    expect(new URL(googleDocsAuthorizeUrl(params, real)).host).toBe("accounts.google.com")
  })
})
