import { describe, expect, it } from "vitest"

import { ProviderError } from "@/lib/integrations/core/types"
import {
  MICROSOFT_SCOPES,
  exchangeMicrosoftCode,
  isValidMicrosoftTenant,
  microsoftAuthorizeUrl,
  microsoftEnv,
  refreshMicrosoftToken,
} from "@/lib/integrations/microsoft/oauth"
import { microsoftProvider } from "@/lib/integrations/microsoft/provider"

import { createFakeFetch, fixture, json } from "./helpers/provider-fake-fetch"

const ENV = {
  MS_CLIENT_ID: "client-id",
  MS_CLIENT_SECRET: "client-secret",
  MS_TENANT: "organizations",
} as unknown as NodeJS.ProcessEnv
const TOKEN_URL = "POST https://login.microsoftonline.com/organizations/oauth2/v2.0/token"
const ME_URL = "GET https://graph.microsoft.com/v1.0/me"
const NOW = () => new Date("2026-10-13T12:00:00.000Z")

describe("microsoft env", () => {
  it("falls back to AZURE_* and validates the tenant segment", () => {
    expect(microsoftEnv({ AZURE_CLIENT_ID: "a", AZURE_CLIENT_SECRET: "b", AZURE_TENANT_ID: "contoso.onmicrosoft.com" } as never))
      .toMatchObject({ clientId: "a", clientSecret: "b", tenant: "contoso.onmicrosoft.com" })
    expect(microsoftEnv({ MS_CLIENT_ID: "a", MS_CLIENT_SECRET: "b", MS_TENANT: "../evil" } as never)).toBeUndefined()
    expect(microsoftEnv({} as never)).toBeUndefined()
    expect(isValidMicrosoftTenant("72f988bf-86f1-41af-91ab-2d7cd011db47")).toBe(true)
    expect(isValidMicrosoftTenant("common")).toBe(true)
    expect(isValidMicrosoftTenant("x/y")).toBe(false)
    expect(microsoftProvider.configured(ENV)).toBe(true)
    expect(microsoftProvider.configured({} as never)).toBe(false)
  })
})

describe("microsoft authorize url", () => {
  it("uses PKCE S256, select_account and never requests OnlineMeetings.Read", () => {
    const url = new URL(
      microsoftAuthorizeUrl({ state: "st", redirectUri: "https://app.example/api/integrations/microsoft/oauth/callback", codeChallenge: "cc" }, ENV)
    )

    expect(url.origin + url.pathname).toBe("https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("code_challenge")).toBe("cc")
    expect(url.searchParams.get("prompt")).toBe("select_account")
    expect(url.searchParams.get("response_mode")).toBe("query")
    expect(url.searchParams.get("scope")).toBe("openid profile email offline_access User.Read Calendars.Read")
    expect(url.searchParams.get("scope")).not.toContain("OnlineMeetings")
    expect(MICROSOFT_SCOPES).not.toContain("OnlineMeetings.Read")
    expect(microsoftProvider.oauth?.pkce).toBe(true)
    expect(microsoftProvider.oauth?.scopes).toEqual([...MICROSOFT_SCOPES])
    expect(() => microsoftAuthorizeUrl({ state: "s", redirectUri: "r" }, ENV)).toThrow(ProviderError)
  })
})

describe("microsoft code exchange", () => {
  it("exchanges with the verifier, reads /me and labels the account tid:oid", async () => {
    const { fetch, calls } = createFakeFetch([
      { match: TOKEN_URL, respond: json(fixture("microsoft/token.json")) },
      { match: ME_URL, respond: json(fixture("microsoft/me.json")) },
    ])
    const result = await exchangeMicrosoftCode("the-code", { redirectUri: "https://r", codeVerifier: "verifier" }, { fetch, env: ENV, now: NOW })

    expect(result.account).toEqual({
      externalId: "72f988bf-86f1-41af-91ab-2d7cd011db47:0c5d8d2f-1111-4c55-9b2c-000000000001",
      label: "Yossi@Acme.co.il",
    })
    expect(result.accessToken).toBe("fixture-ms-access-token-AAA")
    expect(result.refreshToken).toBe("fixture-ms-refresh-token-RRR")
    expect(result.expiresAt).toBe("2026-10-13T13:00:00.000Z")
    expect(result.scopes).toContain("Calendars.Read")
    expect(result.config).toEqual({ calendarSyncEnabled: false, tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47" })
    expect(JSON.stringify(result.config)).not.toContain("token")
    expect(calls[0]?.body).toMatchObject({ grant_type: "authorization_code", code: "the-code", code_verifier: "verifier" })
    expect(calls[1]?.headers.authorization).toBe("Bearer fixture-ms-access-token-AAA")
    expect(calls.every((call) => call.provider === "microsoft")).toBe(true)
  })

  it("rejects a tenant outside MS_ALLOWED_TENANTS before calling Graph", async () => {
    const { fetch, calls } = createFakeFetch([{ match: TOKEN_URL, respond: json(fixture("microsoft/token.json")) }])

    await expect(
      exchangeMicrosoftCode("c", { redirectUri: "r", codeVerifier: "v" }, { fetch, env: { ...ENV, MS_ALLOWED_TENANTS: "11111111-1111-1111-1111-111111111111" } })
    ).rejects.toMatchObject({ kind: "forbidden", providerCode: "tenant_not_allowed" })
    expect(calls).toHaveLength(1)

    const allowed = createFakeFetch([
      { match: TOKEN_URL, respond: json(fixture("microsoft/token.json")) },
      { match: ME_URL, respond: json(fixture("microsoft/me.json")) },
    ])

    await expect(
      exchangeMicrosoftCode("c", { redirectUri: "r", codeVerifier: "v" }, {
        fetch: allowed.fetch,
        env: { ...ENV, MS_ALLOWED_TENANTS: " 72F988BF-86f1-41af-91ab-2d7cd011db47 " },
      })
    ).resolves.toMatchObject({ account: { label: "Yossi@Acme.co.il" } })
  })

  it("refuses an exchange without a PKCE verifier", async () => {
    const { fetch } = createFakeFetch([])

    await expect(exchangeMicrosoftCode("c", { redirectUri: "r" }, { fetch, env: ENV })).rejects.toMatchObject({ kind: "config" })
  })
})

describe("microsoft refresh", () => {
  it("returns the rotated refresh token so the store persists it", async () => {
    const { fetch, calls } = createFakeFetch([{ match: TOKEN_URL, respond: json(fixture("microsoft/token-refreshed.json")) }])
    const tokens = await refreshMicrosoftToken("fixture-ms-refresh-token-RRR", { fetch, env: ENV, now: NOW })

    expect(tokens).toMatchObject({ accessToken: "fixture-ms-access-token-BBB", refreshToken: "fixture-ms-refresh-token-ROTATED" })
    expect(calls[0]?.body).toMatchObject({ grant_type: "refresh_token", refresh_token: "fixture-ms-refresh-token-RRR" })
  })

  it("maps invalid_grant / AADSTS70008x to an auth error without reflecting the description", async () => {
    const { fetch } = createFakeFetch([{ match: TOKEN_URL, respond: json(fixture("microsoft/token-invalid-grant.json"), 400) }])
    const error = await refreshMicrosoftToken("r", { fetch, env: ENV }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ProviderError)
    expect(error).toMatchObject({ kind: "auth", providerCode: "invalid_grant" })
    expect((error as Error).message).not.toContain("AADSTS")
  })

  it("maps interaction_required and AADSTS codes even with another error name", async () => {
    for (const body of [
      { error: "interaction_required", error_description: "x" },
      { error: "invalid_request", error_description: "AADSTS700084: The refresh token was issued to a single page app" },
    ]) {
      const { fetch } = createFakeFetch([{ match: TOKEN_URL, respond: json(body, 400) }])

      await expect(refreshMicrosoftToken("r", { fetch, env: ENV })).rejects.toMatchObject({ kind: "auth" })
    }

    const busy = createFakeFetch([{ match: TOKEN_URL, respond: json({ error: "temporarily_unavailable" }, 503) }])

    await expect(refreshMicrosoftToken("r", { fetch: busy.fetch, env: ENV })).rejects.toMatchObject({ kind: "retryable" })
  })
})
