import { createHmac, hkdfSync } from "node:crypto"

import { describe, expect, it } from "vitest"

import { signUnsubscribeToken, verifyUnsubscribeToken } from "@/lib/integrations/email-recap/unsubscribe-token"

/**
 * M8 e2e fix #9: the unsubscribe token is opaque: the address is encrypted
 * (AES-GCM), never readable from the link; tampering fails; links already
 * sent with the v1 format still verify.
 */

const ENV = { NODE_ENV: "test", MEETSUM_SESSION_SECRET: "test-session-secret-for-unsubscribe-tokens" } as unknown as NodeJS.ProcessEnv
const EMAIL = "dana.cohen@customer.example"

describe("unsubscribe token", () => {
  it("does not reveal the address, and round-trips", () => {
    const token = signUnsubscribeToken({ workspaceId: "ws_a", email: EMAIL }, ENV)
    const decoded = Buffer.from(token.replace(/^u2\./, ""), "base64url").toString("latin1")

    expect(token).not.toContain("dana")
    expect(decoded).not.toContain("dana")
    expect(decoded).not.toContain("customer.example")
    expect(token).not.toContain(Buffer.from(EMAIL).toString("base64url").slice(0, 12))
    expect(verifyUnsubscribeToken(token, ENV)).toMatchObject({ ws: "ws_a", e: EMAIL })
  })

  it("rejects a tampered token or another secret", () => {
    const token = signUnsubscribeToken({ workspaceId: "ws_a", email: EMAIL }, ENV)
    const flipped = `${token.slice(0, -2)}${token.endsWith("AA") ? "BB" : "AA"}`

    expect(verifyUnsubscribeToken(flipped, ENV)).toBeUndefined()
    expect(verifyUnsubscribeToken(token, { ...ENV, MEETSUM_SESSION_SECRET: "another-secret-value-for-unsubscribe" } as NodeJS.ProcessEnv)).toBeUndefined()
  })

  it("still verifies a v1 link already sent", () => {
    const body = Buffer.from(JSON.stringify({ v: 1, ws: "ws_a", e: EMAIL, iat: 1 }), "utf8").toString("base64url")
    const key = Buffer.from(hkdfSync("sha256", "test-session-secret-for-unsubscribe-tokens", Buffer.alloc(0), "meetsum:email-unsubscribe", 32))
    const v1 = `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`

    expect(verifyUnsubscribeToken(v1, ENV)).toMatchObject({ ws: "ws_a", e: EMAIL })
  })
})
