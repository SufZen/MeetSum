import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const recordAuditLog = vi.hoisted(() => vi.fn(async (input: unknown) => void input))

vi.mock("@/lib/audit", () => ({ recordAuditLog }))

import { GET, POST } from "@/app/api/email/unsubscribe/route"
import { setIntegrationStoreForTesting, type IntegrationStore } from "@/lib/integrations/core/store"
import { createMemoryIntegrationStore } from "@/lib/integrations/core/store-memory"
import { addressHash } from "@/lib/integrations/email-recap/unsubscribe-store"
import { signUnsubscribeToken, unsubscribeUrl, verifyUnsubscribeToken } from "@/lib/integrations/email-recap/unsubscribe-token"
import { resetRateLimitsForTesting } from "@/lib/rate-limit"

/**
 * M8 A10 unsubscribe: tampered tokens are a bare 400, GET never mutates
 * (302 to the confirmation page), RFC 8058 one-click POST and the page's
 * form POST record it, a token is bound to its workspace, and the audit
 * carries only the address hash.
 */

process.env.MEETSUM_SESSION_SECRET ??= "test-session-secret-for-integrations"

const params = { params: Promise.resolve({}) }

describe("email unsubscribe", () => {
  let store: IntegrationStore

  beforeEach(() => {
    vi.clearAllMocks()
    resetRateLimitsForTesting()
    store = createMemoryIntegrationStore()
    setIntegrationStoreForTesting(store)
  })

  afterEach(() => setIntegrationStoreForTesting(undefined))

  const token = (workspaceId = "ws_a", email = "Dana@Acme.test") => signUnsubscribeToken({ workspaceId, email })

  it("signs a workspace-bound token and refuses tampering", () => {
    const value = token()
    const [body, mac] = value.split(".")
    const forged = Buffer.from(JSON.stringify({ v: 1, ws: "ws_b", e: "dana@acme.test", iat: 1 })).toString("base64url")

    expect(verifyUnsubscribeToken(value)).toMatchObject({ ws: "ws_a", e: "dana@acme.test" })
    expect(verifyUnsubscribeToken(`${forged}.${mac}`)).toBeUndefined()
    expect(verifyUnsubscribeToken(`${body}.${mac}x`)).toBeUndefined()
    expect(verifyUnsubscribeToken(value, { ...process.env, MEETSUM_SESSION_SECRET: "another-secret" })).toBeUndefined()
    expect(unsubscribeUrl(value, { NEXT_PUBLIC_APP_URL: "https://app.test" } as NodeJS.ProcessEnv, "he")).toBe(
      `https://app.test/api/email/unsubscribe?t=${encodeURIComponent(value)}&l=he`
    )
  })

  it("GET redirects to the confirmation page and never mutates", async () => {
    const value = token()
    const response = await GET(new Request(`http://localhost/api/email/unsubscribe?t=${encodeURIComponent(value)}&l=he`), params)

    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe(`/he/unsubscribe?t=${encodeURIComponent(value)}`)
    expect((await store.listUnsubscribed("ws_a", ["dana@acme.test"])).size).toBe(0)
    expect(recordAuditLog).not.toHaveBeenCalled()
  })

  it("answers a bare 400 for an invalid token", async () => {
    const response = await GET(new Request("http://localhost/api/email/unsubscribe?t=nope"), params)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "invalid_token" })
    expect((await POST(new Request("http://localhost/api/email/unsubscribe?t=nope", { method: "POST" }), params)).status).toBe(400)
  })

  it("records an RFC 8058 one-click POST in the token's workspace only, auditing a hash", async () => {
    const response = await POST(
      new Request(`http://localhost/api/email/unsubscribe?t=${encodeURIComponent(token())}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      }),
      params
    )

    expect(response.status).toBe(200)
    expect([...(await store.listUnsubscribed("ws_a", ["dana@acme.test"]))]).toEqual(["dana@acme.test"])
    expect((await store.listUnsubscribed("ws_b", ["dana@acme.test"])).size).toBe(0)
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "email.unsubscribed",
        workspaceId: "ws_a",
        metadata: { addressHash: addressHash("dana@acme.test"), source: "one_click" },
      })
    )
    expect(JSON.stringify(recordAuditLog.mock.calls)).not.toContain("dana@acme.test")
  })

  it("records the confirmation form POST and redirects to the done page", async () => {
    const response = await POST(
      new Request("http://localhost/api/email/unsubscribe", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ t: token("ws_b", "avi@acme.test"), l: "he" }).toString(),
      }),
      params
    )

    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("/he/unsubscribe?done=1")
    expect([...(await store.listUnsubscribed("ws_b", ["avi@acme.test"]))]).toEqual(["avi@acme.test"])
  })
})
