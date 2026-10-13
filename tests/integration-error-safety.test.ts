import { afterEach, describe, expect, it, vi } from "vitest"

import { toConnectionDTO } from "@/lib/integrations/core/connections"
import {
  ProviderHttpError,
  integrationLog,
  providerErrorForResponse,
  publicIntegrationError,
  redactIntegrationError,
  safeProviderCode,
  storedIntegrationError,
  toProviderError,
} from "@/lib/integrations/core/errors"
import { providerFetchWith, setProviderTransportForTesting } from "@/lib/integrations/core/http"
import type { StoredConnection } from "@/lib/integrations/core/store"
import { ProviderError } from "@/lib/integrations/core/types"

/**
 * Security review follow-up: a provider error whose body carries a token,
 * an OAuth code and an email never reaches a log line, a stored
 * `last_error` or an API DTO. Stored errors are typed fields only; `cause`
 * is never serialized.
 */

const TOKEN = "xoxb-123456-abcdefSECRET"
const NOTION = "secret_AbCdEf0123456789"
const CODE = "4/0AbCdEfGh-oauth-code"
const EMAIL = "dana.cohen@example.com"
const BODY = JSON.stringify({
  ok: false,
  error: "invalid_auth",
  detail: `token=${TOKEN} code=${CODE} recipient ${EMAIL} ${NOTION} https://slack.com/api/x?token=${TOKEN}`,
  access_token: TOKEN,
})
const LEAKS = [TOKEN, NOTION, CODE, EMAIL, "SECRET"]

function expectClean(text: string) {
  for (const leak of LEAKS) expect(text, leak).not.toContain(leak)
}

afterEach(() => {
  setProviderTransportForTesting(undefined)
  vi.restoreAllMocks()
})

describe("integration error safety", () => {
  it("redacts tokens, codes, emails, query strings and blobs from log text", () => {
    const text = redactIntegrationError(new Error(`Bearer ${TOKEN} failed: ${BODY} ${"A1b2".repeat(20)}`))

    expectClean(text)
    expect(text).not.toMatch(/A1b2A1b2A1b2/)
    expect(text.length).toBeLessThanOrEqual(500)
  })

  it("redacts HubSpot token paths (legacy token-in-URL endpoints) from log text", () => {
    const text = redactIntegrationError(
      "GET https://api.hubapi.com/oauth/v1/access-tokens/CJSP5qf1KhICAQEYs-gDIIGOBii1hQIyGQAf3xBKmlwHjX7OIpuIFEavB2-qYAGQsF4 and DELETE /oauth/v1/refresh-tokens/de2a6e1d-81ef-4c1b-9a4d-5a3e6b1c0f11"
    )

    expect(text).not.toContain("CJSP5qf1")
    expect(text).not.toContain("de2a6e1d")
    expect(text).toContain("/oauth/v1/access-tokens/[redacted]")
    expect(text).toContain("/oauth/v1/refresh-tokens/[redacted]")
  })

  it("stores only typed fields for a provider error built from a leaky response", async () => {
    setProviderTransportForTesting(async () => new Response(BODY, { status: 401 }))

    const response = await providerFetchWith("slack", "https://slack.com/api/auth.test", {}, { env: { NODE_ENV: "test" } })
    const error = providerErrorForResponse("slack", response, `invalid_auth ${TOKEN}`)
    const stored = storedIntegrationError(error, "slack")

    expect(stored).toBe("code=forbidden kind=auth provider=slack status=401")
    expectClean(stored)
    expectClean(error.message)
    expect(storedIntegrationError(providerErrorForResponse("slack", response, "channel_not_found"), "slack")).toBe(
      "code=forbidden kind=auth provider=slack status=401 provider_code=channel_not_found"
    )
  })

  it("never stores messages of foreign errors and never serializes cause", () => {
    const foreign = new Error(`upstream said ${BODY}`, { cause: new Error(TOKEN) })
    const wrapped = toProviderError(foreign)

    expect(storedIntegrationError(foreign, "notion")).toBe("code=unknown kind=retryable provider=notion")
    expect(wrapped.message).toBe("provider call failed")
    expect(wrapped.cause).toBeUndefined()
    expectClean(JSON.stringify(new ProviderError("invalid", "x", { cause: new Error(TOKEN) })))
    expectClean(JSON.stringify(new ProviderHttpError("invalid", "slack", 400, { providerCode: TOKEN })))
  })

  it("allowlists provider codes as [a-z_]{1,64}", () => {
    expect(safeProviderCode("channel_not_found")).toBe("channel_not_found")
    expect(safeProviderCode("Not_In_Channel")).toBe("not_in_channel")
    expect(safeProviderCode(`bad ${TOKEN}`)).toBeUndefined()
    expect(safeProviderCode("x".repeat(65))).toBeUndefined()
  })

  it("drops a non-typed stored error at the API boundary (DTO)", () => {
    const row: StoredConnection = {
      id: "intc_1",
      workspaceId: "ws_a",
      provider: "slack",
      status: "error",
      accountLabel: "Team",
      externalAccountId: "T1",
      scopes: [],
      accessTokenEnc: "v2:a:b:c",
      config: {},
      generation: 0,
      lastError: `legacy free text ${BODY}`,
      createdAt: "2026-10-13T00:00:00.000Z",
      updatedAt: "2026-10-13T00:00:00.000Z",
    }
    const dto = JSON.stringify(toConnectionDTO(row, { fake: false }))

    expectClean(dto)
    expect(dto).not.toContain("v2:a:b:c")
    expect(publicIntegrationError("code=unknown kind=invalid provider=slack status=404 provider_code=channel_not_found")).toBe(
      "code=unknown kind=invalid provider=slack status=404 provider_code=channel_not_found"
    )
  })

  it("routes logs through the redactor", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)

    integrationLog.warn(`revoke failed for ${EMAIL}`, new Error(BODY))
    integrationLog.error("deliver failed", { body: BODY })

    expectClean(JSON.stringify([...warn.mock.calls, ...error.mock.calls]))
  })
})
