import { beforeEach, describe, expect, it, vi } from "vitest"

import type { SessionContext } from "@/lib/auth/authz"
import { completeOAuth, startOAuth } from "@/lib/integrations/core/oauth"
import {
  oauthRedirectBase,
  oauthRedirectUri,
  safeIntegrationReturnTo,
  signOAuthState,
  verifyOAuthState,
  withIntegrationError,
} from "@/lib/integrations/core/oauth-state"
import type { IntegrationStore } from "@/lib/integrations/core/store"
import { createMemoryIntegrationStore } from "@/lib/integrations/core/store-memory"
import { openToken } from "@/lib/integrations/core/tokens"
import { ProviderError, type IntegrationProvider, type OAuthExchangeResult } from "@/lib/integrations/core/types"
import type { WorkspaceRole } from "@/lib/workspaces/types"

vi.mock("@/lib/audit", () => ({ recordAuditLog: vi.fn(async () => undefined) }))

/**
 * M8 A1 OAuth: tampered signature, expired state, nonce reuse, cookie
 * mismatch, user mismatch, removed member, demoted member, provider
 * mismatch, `returnTo` open redirect, provider `error=`, redirect base from
 * env only, PKCE verifier round trip.
 */

process.env.MEETSUM_SESSION_SECRET ??= "test-session-secret-for-integrations"

const ENV = {
  NODE_ENV: "test",
  MEETSUM_SESSION_SECRET: "oauth-state-test-secret",
  MEETSUM_OAUTH_REDIRECT_BASE: "https://meetsum.example.com",
} as NodeJS.ProcessEnv

type ExchangeFn = (code: string, params: { redirectUri: string; codeVerifier?: string }) => Promise<OAuthExchangeResult>

function fakeProvider(id: "slack" | "microsoft", pkce: boolean, exchange: ExchangeFn = vi.fn<ExchangeFn>()): IntegrationProvider {
  return {
    id,
    scope: id === "slack" ? "workspace" : "user",
    configured: () => true,
    oauth: {
      pkce,
      scopes: ["a"],
      authorizeUrl: ({ state, redirectUri, codeChallenge }) =>
        `https://${id === "slack" ? "slack.com" : "login.microsoftonline.com"}/authorize?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}${codeChallenge ? `&code_challenge=${codeChallenge}` : ""}`,
      exchangeCode: exchange,
    },
  }
}

function session(userId: string, role: WorkspaceRole | undefined, workspaceId = "ws_a"): SessionContext {
  return {
    user: { id: userId, email: `${userId}@acme.test` },
    memberships: role ? [{ workspaceId, userId, role, createdAt: "" } as SessionContext["memberships"][number]] : [],
  }
}

describe("OAuth state", () => {
  it("rejects a tampered signature and an expired state", () => {
    const state = signOAuthState({ n: "n1", p: "slack", ws: "ws_a", u: "u1", exp: Date.now() + 60_000 }, ENV)
    const [body, mac] = state.split(".")
    const forged = Buffer.from(JSON.stringify({ v: 1, n: "n1", p: "slack", ws: "ws_b", u: "u1", exp: Date.now() + 60_000 })).toString("base64url")

    expect(verifyOAuthState(state, { env: ENV }).ok).toBe(true)
    expect(verifyOAuthState(`${forged}.${mac}`, { env: ENV })).toEqual({ ok: false, code: "invalid_state" })
    expect(verifyOAuthState(`${body}.${mac.slice(0, -2)}xx`, { env: ENV })).toEqual({ ok: false, code: "invalid_state" })
    expect(verifyOAuthState(state, { env: { ...ENV, MEETSUM_SESSION_SECRET: "other" } })).toEqual({ ok: false, code: "invalid_state" })
    expect(verifyOAuthState(state, { env: ENV, now: Date.now() + 120_000 })).toEqual({ ok: false, code: "expired_state" })
    expect(verifyOAuthState("garbage", { env: ENV })).toEqual({ ok: false, code: "invalid_state" })
  })

  it("builds the redirect URI from env only (origin, https in production)", () => {
    expect(oauthRedirectUri("slack", ENV)).toBe("https://meetsum.example.com/api/integrations/slack/oauth/callback")
    expect(oauthRedirectUri("slack", { ...ENV, MEETSUM_OAUTH_REDIRECT_BASE: "https://meetsum.example.com/sub" })).toBeUndefined()
    expect(oauthRedirectBase({ NODE_ENV: "production", MEETSUM_OAUTH_REDIRECT_BASE: "http://meetsum.example.com" } as NodeJS.ProcessEnv)).toBeUndefined()
    expect(oauthRedirectBase({ NODE_ENV: "test", NEXT_PUBLIC_APP_URL: "http://localhost:3000/" } as NodeJS.ProcessEnv)).toBe("http://localhost:3000")
    expect(oauthRedirectBase({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).toBeUndefined()
  })

  it("never returns to another origin", () => {
    for (const value of ["//evil.test", "https://evil.test", "/\\evil.test", "/x\n", "/api/integrations/x", "", null]) {
      expect(safeIntegrationReturnTo(value, "he"), String(value)).toBe("/he?panel=settings&section=integrations")
    }
    expect(safeIntegrationReturnTo("/he?panel=settings&section=integrations&x=1")).toBe("/he?panel=settings&section=integrations&x=1")
  })

  it("adds integration_error with the URL API (second '?', '#', an existing code)", () => {
    expect(withIntegrationError("/he?panel=settings", "denied")).toBe("/he?panel=settings&integration_error=denied")
    expect(withIntegrationError("/he", "denied")).toBe("/he?integration_error=denied")
    // A fragment stays a fragment, after the query.
    expect(withIntegrationError("/he?panel=settings#section", "denied")).toBe("/he?panel=settings&integration_error=denied#section")
    expect(withIntegrationError("/he#top", "denied")).toBe("/he?integration_error=denied#top")
    // A second "?" is part of the query value, not a new query.
    expect(withIntegrationError("/he?a=1?b=2", "denied")).toBe("/he?a=1%3Fb%3D2&integration_error=denied")
    // An existing code is replaced, never duplicated.
    expect(withIntegrationError("/he?integration_error=state&x=1", "denied")).toBe("/he?integration_error=denied&x=1")
  })

  it("never redirects off-site: unsafe returnTo values fall back to the integrations settings path", () => {
    const fallback = "/he?panel=settings&section=integrations&integration_error=denied"

    for (const value of [
      "//evil.com",
      "/\\evil.com",
      "/%2F%2Fevil.com",
      "/%252F%252Fevil.com",
      "/%5Cevil.com",
      "https://evil.com",
      "https:evil.com",
      "/\t/evil.com",
      "/\n/evil.com",
      "javascript:alert(1)",
      "/api/integrations/slack/oauth/start",
      "",
    ]) {
      const result = withIntegrationError(value, "denied", "he")

      expect(result, JSON.stringify(value)).toBe(fallback)
      expect(result.startsWith("/") && !result.startsWith("//")).toBe(true)
      expect(safeIntegrationReturnTo(value, "he"), JSON.stringify(value)).toBe("/he?panel=settings&section=integrations")
    }
  })

  it("keeps the error code in the query, not the fragment, for a valid path with ?a=1#frag", () => {
    expect(withIntegrationError("/he/settings?a=1#frag", "denied")).toBe("/he/settings?a=1&integration_error=denied#frag")
  })
})

describe("startOAuth / completeOAuth", () => {
  let store: IntegrationStore
  let exchange: ReturnType<typeof vi.fn<ExchangeFn>>
  let providers: Record<string, IntegrationProvider>
  const exchanged: OAuthExchangeResult = {
    accessToken: "xoxb-fixture",
    scopes: ["chat:write"],
    account: { externalId: "T1", label: "Acme" },
  }

  beforeEach(() => {
    store = createMemoryIntegrationStore()
    exchange = vi.fn<ExchangeFn>(async () => exchanged)
    providers = { slack: fakeProvider("slack", false, exchange), microsoft: fakeProvider("microsoft", true, exchange) }
  })

  const deps = () => ({ store, env: ENV, getProvider: (id: string) => providers[id] })

  async function start(role: WorkspaceRole = "admin", provider = "slack", userId = "u_admin", returnTo = "/he?panel=settings&section=integrations") {
    const result = await startOAuth({ provider, workspaceId: "ws_a", userId, role, returnTo }, deps())

    if (!result.ok) throw new Error(result.code)

    const url = new URL(result.location)

    return { nonce: result.nonce, state: url.searchParams.get("state") ?? "", url }
  }

  function query(state: string, extra: Record<string, string> = { code: "code-1" }) {
    return new URLSearchParams({ state, ...extra })
  }

  it("connects on the happy path and stores encrypted tokens", async () => {
    const { nonce, state, url } = await start()

    expect(url.searchParams.get("redirect_uri")).toBe("https://meetsum.example.com/api/integrations/slack/oauth/callback")

    const result = await completeOAuth({ provider: "slack", session: session("u_admin", "admin"), query: query(state), cookieNonce: nonce }, deps())

    expect(result.code).toBeUndefined()
    expect(result.location).toBe("/he?panel=settings&section=integrations")
    expect(exchange).toHaveBeenCalledWith("code-1", { redirectUri: "https://meetsum.example.com/api/integrations/slack/oauth/callback" })

    const [connection] = await store.listConnections("ws_a")

    expect(connection).toMatchObject({ provider: "slack", accountLabel: "Acme", createdByUserId: "u_admin" })
    expect(openToken(connection, "access_token")).toBe("xoxb-fixture")
  })

  it("uses PKCE S256 for PKCE providers and passes the verifier back", async () => {
    const { nonce, state, url } = await start("member", "microsoft", "u_member")

    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/)

    await completeOAuth({ provider: "microsoft", session: session("u_member", "member"), query: query(state), cookieNonce: nonce }, deps())

    const [, params] = exchange.mock.calls[0] as [string, { codeVerifier?: string }]

    expect(params.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect((await store.listConnections("ws_a"))[0]).toMatchObject({ provider: "microsoft", userId: "u_member" })
  })

  it("refuses start for members on workspace providers, unknown and unconfigured providers", async () => {
    expect(await startOAuth({ provider: "slack", workspaceId: "ws_a", userId: "u", role: "member" }, deps())).toEqual({
      ok: false,
      status: 403,
      code: "forbidden",
    })
    expect(await startOAuth({ provider: "nope", workspaceId: "ws_a", userId: "u", role: "admin" }, deps())).toMatchObject({ status: 404 })
    providers.slack = { ...providers.slack, configured: () => false }
    expect(await startOAuth({ provider: "slack", workspaceId: "ws_a", userId: "u", role: "admin" }, deps())).toMatchObject({
      status: 409,
      code: "integration_not_configured",
    })
    providers.slack = fakeProvider("slack", false, exchange)
    expect(
      await startOAuth({ provider: "slack", workspaceId: "ws_a", userId: "u", role: "admin" }, { ...deps(), env: { ...ENV, MEETSUM_OAUTH_REDIRECT_BASE: "https://x.test/path" } })
    ).toMatchObject({ status: 409, code: "integration_not_configured" })
  })

  const cases: [string, (ctx: { nonce: string; state: string }) => Parameters<typeof completeOAuth>[0], string][] = [
    ["tampered state", ({ nonce, state }) => ({ provider: "slack", session: session("u_admin", "admin"), query: query(`${state}x`), cookieNonce: nonce }), "invalid_state"],
    ["cookie mismatch", ({ state }) => ({ provider: "slack", session: session("u_admin", "admin"), query: query(state), cookieNonce: "other" }), "invalid_state"],
    ["missing cookie", ({ state }) => ({ provider: "slack", session: session("u_admin", "admin"), query: query(state) }), "invalid_state"],
    ["user mismatch", ({ nonce, state }) => ({ provider: "slack", session: session("u_other", "admin"), query: query(state), cookieNonce: nonce }), "forbidden"],
    ["removed member", ({ nonce, state }) => ({ provider: "slack", session: session("u_admin", undefined), query: query(state), cookieNonce: nonce }), "forbidden"],
    ["demoted member", ({ nonce, state }) => ({ provider: "slack", session: session("u_admin", "member"), query: query(state), cookieNonce: nonce }), "forbidden"],
    ["member of another workspace only", ({ nonce, state }) => ({ provider: "slack", session: session("u_admin", "admin", "ws_b"), query: query(state), cookieNonce: nonce }), "forbidden"],
    ["provider mismatch", ({ nonce, state }) => ({ provider: "microsoft", session: session("u_admin", "admin"), query: query(state), cookieNonce: nonce }), "provider_mismatch"],
    ["provider error= param", ({ nonce, state }) => ({ provider: "slack", session: session("u_admin", "admin"), query: query(state, { error: "access_denied" }), cookieNonce: nonce }), "denied"],
  ]

  it.each(cases)("rejects %s without exchanging", async (_name, build, code) => {
    const started = await start()
    const result = await completeOAuth(build(started), deps())

    expect(result.code).toBe(code)
    expect(result.location).toMatch(new RegExp(`integration_error=${code}`))
    expect(result.location.startsWith("/")).toBe(true)
    expect(exchange).not.toHaveBeenCalled()
    expect(await store.listConnections("ws_a")).toEqual([])
  })

  it("rejects nonce reuse (single use) and an expired state", async () => {
    const { nonce, state } = await start()

    await completeOAuth({ provider: "slack", session: session("u_admin", "admin"), query: query(state), cookieNonce: nonce }, deps())
    expect(
      (await completeOAuth({ provider: "slack", session: session("u_admin", "admin"), query: query(state), cookieNonce: nonce }, deps())).code
    ).toBe("invalid_state")

    const late = await start()

    expect(
      (
        await completeOAuth(
          { provider: "slack", session: session("u_admin", "admin"), query: query(late.state), cookieNonce: late.nonce },
          { ...deps(), now: () => Date.now() + 11 * 60_000 }
        )
      ).code
    ).toBe("expired_state")
  })

  it("maps exchange failures to a fixed code and never reflects provider text", async () => {
    exchange.mockRejectedValueOnce(new Error("invalid_code: xoxb-secret dana@acme.test"))

    const { nonce, state } = await start()
    const result = await completeOAuth({ provider: "slack", session: session("u_admin", "admin"), query: query(state), cookieNonce: nonce }, deps())

    expect(result.location).toBe("/he?panel=settings&section=integrations&integration_error=exchange_failed")
  })

  it("maps Microsoft's tenant_not_allowed ProviderError to integration_error=tenant_not_allowed", async () => {
    exchange.mockRejectedValueOnce(new ProviderError("forbidden", "microsoft tenant not allowed", { providerCode: "tenant_not_allowed" }))

    const { nonce, state } = await start()
    const result = await completeOAuth({ provider: "slack", session: session("u_admin", "admin"), query: query(state), cookieNonce: nonce }, deps())

    expect(result.location).toBe("/he?panel=settings&section=integrations&integration_error=tenant_not_allowed")
  })

  it("keeps a malicious returnTo on the same origin", async () => {
    const { nonce, state } = await start("admin", "slack", "u_admin", "//evil.test/steal")
    const result = await completeOAuth({ provider: "slack", session: session("u_admin", "admin"), query: query(state), cookieNonce: nonce }, deps())

    expect(result.location).toBe("/en?panel=settings&section=integrations")
  })
})
