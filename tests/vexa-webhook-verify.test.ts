import { describe, expect, it } from "vitest"

import { constantTimeEqual, signVexaWebhook, verifyVexaSignature } from "@/lib/bot/webhook-verify"

/** M7 B3: Vexa HMAC signature + optional Bearer, constant-time and non-throwing. */

const SECRET = "whsec_0123456789abcdef0123456789abcdef"
const NOW = new Date("2026-10-13T10:00:00Z")
const TS = String(Math.floor(NOW.getTime() / 1000))
const BODY = JSON.stringify({ event_type: "meeting.status_change", data: { meeting: { id: 1 } } })

function headers(overrides: Record<string, string> = {}) {
  return new Headers({
    "x-webhook-timestamp": TS,
    "x-webhook-signature": signVexaWebhook(SECRET, TS, BODY),
    ...overrides,
  })
}

describe("verifyVexaSignature", () => {
  it("accepts a valid signature", () => {
    expect(verifyVexaSignature(headers(), BODY, SECRET, NOW)).toEqual({ ok: true, method: "hmac" })
  })

  it("rejects a body tampered by one byte", () => {
    const tampered = BODY.replace('"id":1', '"id":2')

    expect(verifyVexaSignature(headers(), tampered, SECRET, NOW)).toEqual({ ok: false, reason: "mismatch" })
  })

  it("rejects a wrong secret", () => {
    expect(verifyVexaSignature(headers(), BODY, `${SECRET}x`, NOW).ok).toBe(false)
  })

  it("rejects timestamps older than 300 s or in the future", () => {
    const old = String(Number(TS) - 301)
    const future = String(Number(TS) + 301)

    expect(
      verifyVexaSignature(
        headers({ "x-webhook-timestamp": old, "x-webhook-signature": signVexaWebhook(SECRET, old, BODY) }),
        BODY,
        SECRET,
        NOW
      )
    ).toEqual({ ok: false, reason: "stale" })
    expect(
      verifyVexaSignature(
        headers({ "x-webhook-timestamp": future, "x-webhook-signature": signVexaWebhook(SECRET, future, BODY) }),
        BODY,
        SECRET,
        NOW
      )
    ).toEqual({ ok: false, reason: "stale" })
    expect(verifyVexaSignature(headers({ "x-webhook-timestamp": "abc" }), BODY, SECRET, NOW).ok).toBe(false)
  })

  it("rejects missing headers", () => {
    expect(verifyVexaSignature(new Headers(), BODY, SECRET, NOW)).toEqual({ ok: false, reason: "missing" })
    expect(
      verifyVexaSignature(new Headers({ "x-webhook-timestamp": TS }), BODY, SECRET, NOW).ok
    ).toBe(false)
    expect(verifyVexaSignature(headers(), BODY, "", NOW).ok).toBe(false)
  })

  it("accepts Bearer only when allowed, compared in constant time", () => {
    const bearer = new Headers({ authorization: `Bearer ${SECRET}` })

    expect(verifyVexaSignature(bearer, BODY, SECRET, NOW)).toEqual({ ok: false, reason: "missing" })
    expect(verifyVexaSignature(bearer, BODY, SECRET, NOW, { allowBearer: true })).toEqual({
      ok: true,
      method: "bearer",
    })
    expect(
      verifyVexaSignature(new Headers({ authorization: "Bearer nope" }), BODY, SECRET, NOW, {
        allowBearer: true,
      })
    ).toEqual({ ok: false, reason: "mismatch" })
  })

  it("never throws on a length mismatch", () => {
    expect(() =>
      verifyVexaSignature(headers({ "x-webhook-signature": "sha256=ab" }), BODY, SECRET, NOW)
    ).not.toThrow()
    expect(verifyVexaSignature(headers({ "x-webhook-signature": "sha256=ab" }), BODY, SECRET, NOW).ok).toBe(false)
    expect(constantTimeEqual("short", "much longer value")).toBe(false)
    expect(constantTimeEqual("same", "same")).toBe(true)
  })

  it("accepts a plain header record", () => {
    expect(
      verifyVexaSignature(
        { "X-Webhook-Timestamp": TS, "X-Webhook-Signature": signVexaWebhook(SECRET, TS, BODY) },
        BODY,
        SECRET,
        NOW
      ).ok
    ).toBe(true)
  })
})
