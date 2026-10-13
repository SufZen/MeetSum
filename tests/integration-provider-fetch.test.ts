import { afterEach, describe, expect, it, vi } from "vitest"

import { parseRetryAfter, redactIntegrationError } from "@/lib/integrations/core/errors"
import {
  assertIntegrationsBootConfig,
  getFakeBaseUrl,
  isValidMicrosoftTenant,
  providerAuthorizeUrl,
  providerFetchWith,
  rewriteForFakeMode,
  setProviderTransportForTesting,
} from "@/lib/integrations/core/http"
import { ProviderError } from "@/lib/integrations/core/types"

/**
 * M8 "Outbound HTTP": exact host allowlist, https only, redirects refused,
 * size cap, timeout, Microsoft tenant validation, fake mode refused in
 * production; plus error redaction.
 */

const DEV = { NODE_ENV: "test" } as NodeJS.ProcessEnv

function ok(body: unknown = { ok: true }, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init })
}

afterEach(() => setProviderTransportForTesting(undefined))

async function rejection(promise: Promise<unknown>): Promise<ProviderError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught
  )

  expect(error).toBeInstanceOf(ProviderError)
  return error as ProviderError
}

describe("providerFetch", () => {
  it("calls allowlisted https hosts with the integrations user agent and redirect: error", async () => {
    const transport = vi.fn(async () => ok())

    setProviderTransportForTesting(transport)

    const response = await providerFetchWith("slack", "https://slack.com/api/auth.test", { method: "POST" }, { env: DEV })

    expect(await response.json()).toEqual({ ok: true })
    const [url, init] = transport.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://slack.com/api/auth.test")
    expect(init.redirect).toBe("error")
    expect(new Headers(init.headers).get("user-agent")).toBe("MeetSum-Integrations/1")
  })

  it("refuses hosts outside the provider's exact allowlist, http and credentials in the URL", async () => {
    const transport = vi.fn(async () => ok())

    setProviderTransportForTesting(transport)

    for (const url of [
      "https://evil.slack.com/api/auth.test",
      "https://slack.com.evil.test/api",
      "http://slack.com/api/auth.test",
      "https://user:pw@slack.com/api",
      "https://slack.com:8443/api",
      "https://api.notion.com/v1/users/me",
      "not a url",
    ]) {
      expect((await rejection(providerFetchWith("slack", url, {}, { env: DEV }))).kind, url).toBe("config")
    }
    expect((await rejection(providerFetchWith("hubspot", "https://app.hubspot.com/oauth", {}, { env: DEV }))).kind).toBe("config")
    expect(transport).not.toHaveBeenCalled()
  })

  it("validates the Microsoft tenant path segment", async () => {
    setProviderTransportForTesting(async () => ok())

    expect(isValidMicrosoftTenant("organizations")).toBe(true)
    expect(isValidMicrosoftTenant("common")).toBe(true)
    expect(isValidMicrosoftTenant("72f988bf-86f1-41af-91ab-2d7cd011db47")).toBe(true)
    expect(isValidMicrosoftTenant("contoso.onmicrosoft.com")).toBe(true)
    expect(isValidMicrosoftTenant("..")).toBe(false)
    expect(isValidMicrosoftTenant("a/b")).toBe(false)

    await providerFetchWith("microsoft", "https://login.microsoftonline.com/organizations/oauth2/v2.0/token", {}, { env: DEV })
    expect(
      (await rejection(providerFetchWith("microsoft", "https://login.microsoftonline.com/%2e%2e/oauth2/v2.0/token", {}, { env: DEV }))).kind
    ).toBe("config")
  })

  it("turns a redirect into an error", async () => {
    setProviderTransportForTesting(async () => {
      throw new TypeError("fetch failed: unexpected redirect")
    })
    expect((await rejection(providerFetchWith("slack", "https://slack.com/api/x", {}, { env: DEV }))).kind).toBe("invalid")

    setProviderTransportForTesting(async () => new Response(null, { status: 302, headers: { location: "https://evil.test" } }))
    expect((await rejection(providerFetchWith("slack", "https://slack.com/api/x", {}, { env: DEV }))).kind).toBe("invalid")
  })

  it("caps the response size", async () => {
    setProviderTransportForTesting(async () => new Response("x".repeat(64), { status: 200 }))

    expect((await rejection(providerFetchWith("slack", "https://slack.com/api/x", {}, { env: DEV, maxBytes: 32 }))).message).toMatch(
      /too large/
    )

    setProviderTransportForTesting(async () => new Response("x", { status: 200, headers: { "content-length": "999999999" } }))
    expect((await rejection(providerFetchWith("slack", "https://slack.com/api/x", {}, { env: DEV }))).kind).toBe("invalid")
  })

  it("times out as retryable", async () => {
    setProviderTransportForTesting(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
        })
    )

    const error = await rejection(providerFetchWith("slack", "https://slack.com/api/x", {}, { env: DEV, timeoutMs: 20 }))

    expect(error.kind).toBe("retryable")
    expect(error.message).toMatch(/timed out/)
  })

  it("maps network failures to retryable without leaking the cause text", async () => {
    setProviderTransportForTesting(async () => {
      throw new Error("connect ECONNREFUSED xoxb-secret-token")
    })

    const error = await rejection(providerFetchWith("slack", "https://slack.com/api/x", {}, { env: DEV }))

    expect(error.kind).toBe("retryable")
    expect(error.message).not.toContain("xoxb")
  })
})

describe("fake mode", () => {
  const FAKE = { NODE_ENV: "development", MEETSUM_INTEGRATIONS_FAKE_BASE_URL: "http://127.0.0.1:4010" } as NodeJS.ProcessEnv

  it("rewrites provider origins to the loopback fake server", async () => {
    const transport = vi.fn(async () => ok())

    setProviderTransportForTesting(transport)
    await providerFetchWith("slack", "https://slack.com/api/chat.postMessage?x=1", { method: "POST" }, { env: FAKE })

    expect((transport.mock.calls[0] as unknown as [string])[0]).toBe("http://127.0.0.1:4010/slack.com/api/chat.postMessage?x=1")
    expect(rewriteForFakeMode("https://app.hubspot.com/oauth/authorize?a=b", FAKE)).toBe(
      "http://127.0.0.1:4010/app.hubspot.com/oauth/authorize?a=b"
    )
  })

  it("still enforces the host allowlist before rewriting", async () => {
    setProviderTransportForTesting(async () => ok())
    expect((await rejection(providerFetchWith("slack", "https://evil.test/api", {}, { env: FAKE }))).kind).toBe("config")
  })

  it("is refused in production and accepts only loopback http origins", () => {
    expect(() => getFakeBaseUrl({ ...FAKE, NODE_ENV: "production" })).toThrow(/production/)
    expect(() => assertIntegrationsBootConfig({ ...FAKE, NODE_ENV: "production" })).toThrow(/production/)
    expect(() => getFakeBaseUrl({ ...FAKE, MEETSUM_INTEGRATIONS_FAKE_BASE_URL: "http://10.0.0.5:4010" })).toThrow()
    expect(() => getFakeBaseUrl({ ...FAKE, MEETSUM_INTEGRATIONS_FAKE_BASE_URL: "https://localhost:4010" })).toThrow()
    expect(() => getFakeBaseUrl({ ...FAKE, MEETSUM_INTEGRATIONS_FAKE_BASE_URL: "http://localhost" })).toThrow()
    expect(getFakeBaseUrl({ ...FAKE, MEETSUM_INTEGRATIONS_FAKE_BASE_URL: "http://localhost:4010/" })).toBe("http://localhost:4010")
    expect(getFakeBaseUrl(DEV)).toBeUndefined()
  })

  it("builds authorize URLs only for the provider's authorize hosts", () => {
    expect(providerAuthorizeUrl("slack", "https://slack.com/oauth/v2/authorize", { client_id: "c", state: "s" }, DEV)).toBe(
      "https://slack.com/oauth/v2/authorize?client_id=c&state=s"
    )
    expect(() => providerAuthorizeUrl("slack", "https://evil.test/authorize", {}, DEV)).toThrow()
    expect(providerAuthorizeUrl("slack", "https://slack.com/oauth/v2/authorize", { a: "1" }, FAKE)).toBe(
      "http://127.0.0.1:4010/slack.com/oauth/v2/authorize?a=1"
    )
  })
})

describe("redactIntegrationError and Retry-After", () => {
  it("strips bearer tokens, codes, secrets and emails and caps the length", () => {
    const text = redactIntegrationError(
      new Error(
        "Authorization: Bearer abc.def.ghi failed for dana@example.com code=4/0AbCd refresh_token=1//xyz client_secret: shh xoxb-1-2-3"
      )
    )

    expect(text).not.toMatch(/abc\.def|dana@|4\/0AbCd|1\/\/xyz|shh|xoxb-1/)
    expect(text).toContain("***")
    expect(redactIntegrationError("x".repeat(2000)).length).toBeLessThanOrEqual(500)
    expect(redactIntegrationError("line1\nline2")).toBe("line1 line2")
  })

  it("parses Retry-After seconds and dates, capped at an hour", () => {
    expect(parseRetryAfter("30")).toBe(30_000)
    expect(parseRetryAfter("999999")).toBe(3_600_000)
    expect(parseRetryAfter(new Date(Date.now() + 5000).toUTCString())).toBeGreaterThan(0)
    expect(parseRetryAfter("soon")).toBeUndefined()
    expect(parseRetryAfter(null)).toBeUndefined()
  })
})
